import { randomUUID } from "crypto";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { PlatformEventSchema, type PlatformEvent } from "@3amoncall/core";
import type { Incident, StorageDriver } from "../storage/interface.js";
import type { SpanBuffer } from "../ambient/span-buffer.js";
import {
  extractSpans,
  isAnomalous,
  selectIncidentTriggerSpans,
} from "../domain/anomaly-detector.js";
import {
  buildFormationKey,
  shouldAttachToIncident,
} from "../domain/formation.js";
import {
  extractMetricEvidence,
  extractLogEvidence,
  shouldAttachEvidence,
} from "../domain/evidence-extractor.js";
import { buildAnomalousSignals, createPacket, rebuildPacket } from "../domain/packetizer.js";
import { dispatchThinEvent } from "../runtime/github-dispatch.js";
import { decodeTraces, decodeMetrics, decodeLogs } from "./otlp-protobuf.js";

const gunzipAsync = promisify(gunzip);

const INGEST_BODY_LIMIT = 1 * 1024 * 1024; // 1MB per ADR 0022 (resource exhaustion protection)
const PlatformEventsRequestSchema = z.object({
  events: z.array(PlatformEventSchema),
}).strict();

/**
 * Read the raw request body and decompress if Content-Encoding: gzip.
 * Returns the raw buffer, or an HTTP status code indicating the failure:
 * - 413: decompressed payload exceeds INGEST_BODY_LIMIT (zip bomb protection)
 * - 400: unsupported Content-Encoding or corrupt gzip payload
 */
async function decompressIfNeeded(c: Context): Promise<Uint8Array | 400 | 413> {
  const buf = new Uint8Array(await c.req.raw.arrayBuffer());
  const encoding = c.req.header("Content-Encoding") ?? "";
  if (encoding === "") {
    return buf;
  }
  if (encoding === "gzip") {
    try {
      const decompressed = new Uint8Array(await gunzipAsync(buf));
      if (decompressed.byteLength > INGEST_BODY_LIMIT) {
        return 413; // zip bomb
      }
      return decompressed;
    } catch {
      return 400; // corrupt gzip
    }
  }
  return 400; // unsupported encoding
}

/**
 * Parse an OTLP request body (protobuf or JSON).
 * Returns `{ body: unknown }` on success, or a `Response` on error.
 * The `protoDecoder` is only invoked for application/x-protobuf requests.
 */
async function decodeOtlpBody(
  c: Context,
  protoDecoder: (raw: Uint8Array) => unknown,
): Promise<{ body: unknown } | Response> {
  const ct = c.req.header("Content-Type") ?? "";
  if (ct.includes("application/x-protobuf")) {
    const raw = await decompressIfNeeded(c);
    if (typeof raw === "number") {
      return c.json(
        { error: raw === 413 ? "payload too large after decompression" : "invalid Content-Encoding or corrupt body" },
        raw,
      );
    }
    try {
      return { body: protoDecoder(raw) };
    } catch {
      return c.json({ error: "invalid protobuf body" }, 400);
    }
  } else if (ct.includes("application/json")) {
    try {
      const body = await c.req.json();
      if (typeof body !== "object" || body === null) {
        return c.json({ error: "invalid body" }, 400);
      }
      return { body };
    } catch (err) {
      if (err instanceof SyntaxError) return c.json({ error: "invalid body" }, 400);
      throw err;
    }
  }
  return c.json({ error: "unsupported Content-Type" }, 415);
}

async function listAllIncidents(storage: StorageDriver): Promise<Incident[]> {
  const items: Incident[] = [];
  let cursor: string | undefined = undefined;

  do {
    const page = await storage.listIncidents({ limit: 100, cursor });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  return items;
}

function isPlatformEventCandidate(event: PlatformEvent, incident: Incident): boolean {
  if (incident.status !== "open") return false;
  if (incident.packet.scope.environment !== event.environment) return false;
  if (event.service && !incident.packet.scope.affectedServices.includes(event.service)) return false;

  const eventTimeMs = new Date(event.timestamp).getTime();
  const windowStartMs = new Date(incident.packet.window.start).getTime();
  const windowEndMs = new Date(incident.packet.window.end).getTime();

  return windowStartMs <= eventTimeMs && eventTimeMs <= windowEndMs;
}

function selectBestIncidentForPlatformEvent(
  event: PlatformEvent,
  incidents: Incident[],
): Incident | undefined {
  const eventTimeMs = new Date(event.timestamp).getTime();

  return incidents
    .filter((incident) => isPlatformEventCandidate(event, incident))
    .sort((a, b) => {
      const aDistance = Math.abs(new Date(a.packet.window.detect).getTime() - eventTimeMs);
      const bDistance = Math.abs(new Date(b.packet.window.detect).getTime() - eventTimeMs);
      if (aDistance !== bDistance) return aDistance - bDistance;

      const openedAtDiff = new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime();
      if (openedAtDiff !== 0) return openedAtDiff;

      return a.incidentId.localeCompare(b.incidentId);
    })[0];
}

export function createIngestRouter(storage: StorageDriver, spanBuffer?: SpanBuffer): Hono {
  const app = new Hono();

  app.use(
    "*",
    bodyLimit({
      maxSize: INGEST_BODY_LIMIT,
      onError: (c) => c.json({ error: "payload too large" }, 413),
    }),
  );

  app.post("/v1/traces", async (c) => {
    const result = await decodeOtlpBody(c, decodeTraces);
    if (result instanceof Response) return result;
    const { body } = result;

    const spans = extractSpans(body);
    spans.forEach((span) => spanBuffer?.push({ ...span, ingestedAt: Date.now() }));

    // signalSpans: all anomalous spans (isAnomalous) — for evidence/signal recording.
    // triggerSpans: subset eligible to open a new incident (isIncidentTrigger) —
    //   e.g. SERVER 429 is anomalous evidence but must not open a new incident.
    // Sorted by (startTimeMs asc, serviceName asc) for deterministic primaryService
    // selection — same algorithm as Plan 3 selectPrimaryService().
    const signalSpans = spans.filter(isAnomalous);
    const triggerSpans = selectIncidentTriggerSpans(signalSpans)
      .sort((a, b) =>
        a.startTimeMs !== b.startTimeMs
          ? a.startTimeMs - b.startTimeMs
          : a.serviceName.localeCompare(b.serviceName),
      );

    if (signalSpans.length === 0) {
      return c.json({ status: "ok" });
    }

    // Formation key and signal time: use triggerSpans when available (preserves
    // existing behavior for new-incident creation); fall back to signalSpans for
    // evidence-only batches that have no trigger-eligible spans (e.g. SERVER 429).
    const anchorSpans = triggerSpans.length > 0 ? triggerSpans : signalSpans;
    const formationKey = buildFormationKey(anchorSpans);
    const signalTimeMs = anchorSpans[0].startTimeMs;

    // Find existing open incident for this formation key within window.
    // Phase C: paginate through all pages (cursor loop) so matches are not
    // missed when there are >100 open incidents.
    const page = await storage.listIncidents({ limit: 100 });
    const existing = page.items.find((incident) =>
      shouldAttachToIncident(formationKey, incident, signalTimeMs),
    );

    // Evidence-only path: anomalous signals but no trigger-eligible spans.
    // Append to existing incident as evidence; do not create a new incident.
    if (triggerSpans.length === 0) {
      if (existing) {
        await storage.appendSpans(existing.incidentId, spans);
        await storage.appendAnomalousSignals(existing.incidentId, buildAnomalousSignals(signalSpans));
      }
      return c.json({ status: "ok" });
    }

    const isNew = !existing;
    const incidentId = existing ? existing.incidentId : "inc_" + randomUUID();
    // Use signal time (not server clock) so formation window is anchored to telemetry
    const openedAt = existing
      ? existing.openedAt
      : new Date(triggerSpans[0].startTimeMs).toISOString();

    if (isNew) {
      // Pass all spans (not just anomalous) so the packet captures the full
      // incident-scoped evidence bundle per ADR 0016/0018 (affectedServices,
      // representativeTraces, traceRefs include healthy sibling spans).
      // triggerSignals is computed inside createPacket by re-filtering isAnomalous.
      const packet = createPacket(incidentId, openedAt, spans, formationKey.primaryService);
      await storage.createIncident(packet);
      // ADR 0030: save all spans and anomalous signals to raw state so future
      // rebuilds have the complete incident history as their single source of truth.
      // signalSpans (isAnomalous) is used for evidence — broader than triggerSpans.
      await storage.appendSpans(incidentId, spans);
      await storage.appendAnomalousSignals(incidentId, buildAnomalousSignals(signalSpans));
      const thinEvent = {
        event_id: "evt_" + randomUUID(),
        event_type: "incident.created" as const,
        incident_id: incidentId,
        packet_id: packet.packetId,
      };
      await storage.saveThinEvent(thinEvent);
      // ADR 0021: dispatch the same thin event to GitHub Actions workflow_dispatch.
      // Failure is logged but does not fail the response — thin event is already persisted.
      await dispatchThinEvent(thinEvent);
      return c.json({ status: "ok", incidentId, packetId: packet.packetId });
    }

    // ADR 0030: existing incident attach — append new spans/signals to raw state and
    // rebuild the packet so later signals are reflected in the canonical view.
    // packetId is stable across rebuilds (thin event reference remains valid).
    await storage.appendSpans(incidentId, spans);
    await storage.appendAnomalousSignals(incidentId, buildAnomalousSignals(signalSpans));
    const rawState = await storage.getRawState(incidentId);
    if (rawState !== null) {
      const generation = (existing.packet.generation ?? 1) + 1;
      const rebuiltPacket = rebuildPacket(
        incidentId,
        existing.packet.packetId,
        existing.openedAt,
        rawState,
        undefined,
        generation,
        existing.packet.scope.primaryService,
      );
      await storage.createIncident(rebuiltPacket);
    }
    return c.json({ status: "ok", incidentId, packetId: existing.packet.packetId });
  });

  // OTLP metrics — protobuf + JSON both accepted (ADR 0022).
  // Evidence is extracted and attached to matching open incidents.
  app.post("/v1/metrics", async (c) => {
    const result = await decodeOtlpBody(c, decodeMetrics);
    if (result instanceof Response) return result;
    const { body } = result;

    // No explicit field-presence check: extractMetricEvidence handles missing/empty
    // resourceMetrics gracefully (returns []), keeping protobuf and JSON paths symmetric.
    const evidences = extractMetricEvidence(body);
    if (evidences.length > 0) {
      const page = await storage.listIncidents({ limit: 100 });
      // Plan 6 / B-4: append to rawState then rebuild so packet.evidence is derived.
      // Race/concurrency trade-off: concurrent batches may cause lost updates under
      // OTel Collector batch-processor concurrency — acceptable in Phase 1.
      await Promise.all(
        page.items.flatMap((incident) => {
          const matching = evidences.filter((e) => shouldAttachEvidence(e, incident));
          if (matching.length === 0) return [];
          return [(async () => {
            await storage.appendRawEvidence(incident.incidentId, { metricEvidence: matching });
            const rawState = await storage.getRawState(incident.incidentId);
            if (rawState === null) return;
            const generation = (incident.packet.generation ?? 1) + 1;
            const rebuiltPacket = rebuildPacket(
              incident.incidentId,
              incident.packet.packetId,
              incident.openedAt,
              rawState,
              undefined,
              generation,
              incident.packet.scope.primaryService,
            );
            await storage.createIncident(rebuiltPacket);
          })()];
        }),
      );
    }

    return c.json({ status: "ok" });
  });

  // OTLP logs — protobuf + JSON both accepted (ADR 0022).
  // Only WARN/ERROR/FATAL logs (severityNumber >= 13) are extracted and attached.
  app.post("/v1/logs", async (c) => {
    const result = await decodeOtlpBody(c, decodeLogs);
    if (result instanceof Response) return result;
    const { body } = result;

    // No explicit field-presence check: extractLogEvidence handles missing/empty
    // resourceLogs gracefully (returns []), keeping protobuf and JSON paths symmetric.
    const evidences = extractLogEvidence(body);
    if (evidences.length > 0) {
      const page = await storage.listIncidents({ limit: 100 });
      // Same appendRawEvidence + rebuild pattern as /v1/metrics.
      await Promise.all(
        page.items.flatMap((incident) => {
          const matching = evidences.filter((e) => shouldAttachEvidence(e, incident));
          if (matching.length === 0) return [];
          return [(async () => {
            await storage.appendRawEvidence(incident.incidentId, { logEvidence: matching });
            const rawState = await storage.getRawState(incident.incidentId);
            if (rawState === null) return;
            const generation = (incident.packet.generation ?? 1) + 1;
            const rebuiltPacket = rebuildPacket(
              incident.incidentId,
              incident.packet.packetId,
              incident.openedAt,
              rawState,
              undefined,
              generation,
              incident.packet.scope.primaryService,
            );
            await storage.createIncident(rebuiltPacket);
          })()];
        }),
      );
    }

    return c.json({ status: "ok" });
  });

  // Platform events — JSON only (not OTLP format, ADR 0022 scope boundary).
  app.post("/v1/platform-events", async (c) => {
    const ct = c.req.header("Content-Type") ?? "";
    if (!ct.includes("application/json")) {
      return c.json({ error: "unsupported Content-Type" }, 415);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err) {
      if (err instanceof SyntaxError) return c.json({ error: "invalid body" }, 400);
      throw err;
    }
    if (typeof body !== "object" || body === null) {
      return c.json({ error: "invalid body" }, 400);
    }

    const parsed = PlatformEventsRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid body" }, 400);
    }

    if (parsed.data.events.length === 0) {
      return c.json({ status: "ok" });
    }

    const incidents = await listAllIncidents(storage);
    const eventsByIncidentId = new Map<string, PlatformEvent[]>();

    for (const event of parsed.data.events) {
      const incident = selectBestIncidentForPlatformEvent(event, incidents);
      if (!incident) continue;

      const current = eventsByIncidentId.get(incident.incidentId) ?? [];
      current.push(event);
      eventsByIncidentId.set(incident.incidentId, current);
    }

    for (const [incidentId, events] of eventsByIncidentId) {
      const incident = incidents.find((candidate) => candidate.incidentId === incidentId);
      if (!incident) continue;

      await storage.appendPlatformEvents(incidentId, events);
      const rawState = await storage.getRawState(incidentId);
      if (rawState === null) continue;

      const rebuiltPacket = rebuildPacket(
        incidentId,
        incident.packet.packetId,
        incident.openedAt,
        rawState,
        undefined,
        (incident.packet.generation ?? 1) + 1,
        incident.packet.scope.primaryService,
      );
      await storage.createIncident(rebuiltPacket);
    }

    return c.json({ status: "ok" });
  });

  return app;
}
