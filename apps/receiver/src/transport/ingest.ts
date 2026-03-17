import { randomUUID } from "crypto";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { PlatformEventSchema, type PlatformEvent } from "@3amoncall/core";
import type { Incident, StorageDriver } from "../storage/interface.js";
import { spanMembershipKey } from "../storage/interface.js";
import type { SpanBuffer } from "../ambient/span-buffer.js";
import type { TelemetryStoreDriver, TelemetrySpan } from "../telemetry/interface.js";
import {
  extractSpans,
  isAnomalous,
  selectIncidentTriggerSpans,
} from "../domain/anomaly-detector.js";
import {
  buildFormationKey,
  shouldAttachToIncident,
  getIncidentBoundTraceIds,
  normalizeDependency,
} from "../domain/formation.js";
import {
  shouldAttachEvidence,
} from "../domain/evidence-extractor.js";
import { buildAnomalousSignals, createPacket } from "../domain/packetizer.js";
import { extractTelemetryMetrics, extractTelemetryLogs } from "../telemetry/otlp-extractors.js";
import { rebuildSnapshots } from "../telemetry/snapshot-builder.js";
import { CLEANUP_INTERVAL_MS, RETENTION_MS } from "../telemetry/constants.js";
import { dispatchThinEvent } from "../runtime/github-dispatch.js";
import type { DiagnosisDebouncer } from "../runtime/diagnosis-debouncer.js";
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

// ── Opportunistic TTL cleanup (ADR 0032 Appendix A.5) ─────────────────────────
let lastCleanup = 0;

async function maybeCleanup(telemetryStore: TelemetryStoreDriver): Promise<void> {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  await telemetryStore.deleteExpired(new Date(now - RETENTION_MS));
}

/** Exported for testing only — reset the cleanup timer between test runs. */
export function _resetCleanupTimerForTest(): void {
  lastCleanup = 0;
}

/** Compute scope expansion fields from a batch of spans (used in evidence-only and existing-attach paths). */
function computeScopeExpansion(spans: Array<{ traceId: string; spanId: string; serviceName: string; peerService?: string; startTimeMs: number; durationMs: number }>) {
  const spanIds = spans.map(s => spanMembershipKey(s.traceId, s.spanId));
  const memberServices = [...new Set(spans.map(s => s.serviceName))];
  const dependencyServices = [
    ...new Set(
      spans.flatMap(s => {
        const dep = normalizeDependency(s.peerService);
        return dep !== undefined ? [dep] : [];
      }),
    ),
  ];
  const windowStartMs = Math.min(...spans.map(s => s.startTimeMs));
  const windowEndMs = Math.max(...spans.map(s => s.startTimeMs + s.durationMs));
  return { spanIds, memberServices, dependencyServices, windowStartMs, windowEndMs };
}

/** Create, persist, and dispatch a thin event for an incident. */
async function saveAndDispatchThinEvent(
  incidentId: string,
  packetId: string,
  storage: StorageDriver,
): Promise<void> {
  const thinEvent = {
    event_id: "evt_" + randomUUID(),
    event_type: "incident.created" as const,
    incident_id: incidentId,
    packet_id: packetId,
  };
  await storage.saveThinEvent(thinEvent);
  await dispatchThinEvent(thinEvent);
}

/** Rebuild snapshots and notify the debouncer of the new generation. */
async function rebuildAndNotify(
  incidentId: string,
  telemetryStore: TelemetryStoreDriver,
  storage: StorageDriver,
  debouncer?: DiagnosisDebouncer,
): Promise<void> {
  await rebuildSnapshots(incidentId, telemetryStore, storage);
  if (debouncer) {
    const updated = await storage.getIncident(incidentId);
    if (updated) {
      debouncer.onGenerationUpdate(incidentId, updated.packet.generation ?? 1);
    }
  }
}

export function createIngestRouter(storage: StorageDriver, spanBuffer: SpanBuffer | undefined, telemetryStore: TelemetryStoreDriver, diagnosisDebouncer?: DiagnosisDebouncer): Hono {
  const app = new Hono();

  app.use(
    "*",
    bodyLimit({
      maxSize: INGEST_BODY_LIMIT,
      onError: (c) => c.json({ error: "payload too large" }, 413),
    }),
  );

  app.post("/v1/traces", async (c) => {
    await maybeCleanup(telemetryStore);

    const result = await decodeOtlpBody(c, decodeTraces);
    if (result instanceof Response) return result;
    const { body } = result;

    const spans = extractSpans(body);
    spans.forEach((span) => spanBuffer?.push({ ...span, ingestedAt: Date.now() }));

    // ADR 0032: Ingest spans to TelemetryStore (always available)
    if (spans.length > 0) {
      const now = Date.now();
      const telemetrySpans: TelemetrySpan[] = spans.map((s) => ({
        traceId: s.traceId,
        spanId: s.spanId,
        parentSpanId: s.parentSpanId,
        serviceName: s.serviceName,
        environment: s.environment,
        spanName: s.spanName ?? '',
        httpRoute: s.httpRoute,
        httpStatusCode: s.httpStatusCode,
        spanStatusCode: s.spanStatusCode,
        durationMs: s.durationMs,
        startTimeMs: s.startTimeMs,
        peerService: s.peerService,
        exceptionCount: s.exceptionCount,
        httpMethod: s.httpMethod,
        spanKind: s.spanKind,
        attributes: {},
        ingestedAt: now,
      }));
      await telemetryStore.ingestSpans(telemetrySpans);
    }

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
    // ADR 0033: compute batch traceIds for cross-service trace-based merge.
    const batchTraceIds = new Set(signalSpans.map(s => s.traceId));
    const page = await storage.listIncidents({ limit: 100 });
    const existing = page.items.find((incident) => {
      const incidentTraceIds = getIncidentBoundTraceIds(incident.spanMembership);
      const sharedTraceCount = [...batchTraceIds].filter(id => incidentTraceIds.has(id)).length;
      return shouldAttachToIncident(formationKey, incident, signalTimeMs, sharedTraceCount);
    });

    // Evidence-only path: anomalous signals but no trigger-eligible spans.
    // Append to existing incident as evidence; do not create a new incident.
    if (triggerSpans.length === 0) {
      if (existing) {
        // Expand telemetry scope and membership for existing incident
        const expansion = computeScopeExpansion(spans);
        await storage.expandTelemetryScope(existing.incidentId, expansion);
        await storage.appendSpanMembership(existing.incidentId, expansion.spanIds);
        await storage.appendAnomalousSignals(existing.incidentId, buildAnomalousSignals(signalSpans));
        await rebuildAndNotify(existing.incidentId, telemetryStore, storage, diagnosisDebouncer);
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
      const { packet, initialMembership } = createPacket(incidentId, openedAt, spans, formationKey.primaryService);
      await storage.createIncident(packet, initialMembership);

      // Concurrent race: if createIncident was a no-op (another request created first),
      // fall through to the existing-attach path to ensure this batch's membership is recorded.
      const created = await storage.getIncident(incidentId);
      if (created && created.packet.packetId !== packet.packetId) {
        // Another request won the race — attach our spans to the existing incident
        const expansion = computeScopeExpansion(spans);
        await storage.expandTelemetryScope(incidentId, expansion);
        await storage.appendSpanMembership(incidentId, expansion.spanIds);
        await storage.appendAnomalousSignals(incidentId, buildAnomalousSignals(signalSpans));
        await rebuildAndNotify(incidentId, telemetryStore, storage, diagnosisDebouncer);
        return c.json({ status: "ok", incidentId, packetId: created.packet.packetId });
      }

      // ADR 0032: Rebuild snapshots for new incident
      await rebuildAndNotify(incidentId, telemetryStore, storage, diagnosisDebouncer);

      if (diagnosisDebouncer) {
        // Debouncer active: defer thin event dispatch until generation threshold or max wait.
        // The debouncer's onReady callback will save + dispatch the thin event.
        diagnosisDebouncer.track(incidentId, packet.packetId);
      } else {
        // No debouncer (both env vars = 0): immediate dispatch (backward compat)
        await saveAndDispatchThinEvent(incidentId, packet.packetId, storage);
      }
      return c.json({ status: "ok", incidentId, packetId: packet.packetId });
    }

    // Existing incident attach — expand scope and membership, then rebuild.
    const expansion = computeScopeExpansion(spans);
    await storage.expandTelemetryScope(incidentId, expansion);
    await storage.appendSpanMembership(incidentId, expansion.spanIds);
    await storage.appendAnomalousSignals(incidentId, buildAnomalousSignals(signalSpans));
    await rebuildAndNotify(incidentId, telemetryStore, storage, diagnosisDebouncer);
    return c.json({ status: "ok", incidentId, packetId: existing.packet.packetId });
  });

  // OTLP metrics — protobuf + JSON both accepted (ADR 0022).
  // Evidence is extracted and attached to matching open incidents.
  app.post("/v1/metrics", async (c) => {
    await maybeCleanup(telemetryStore);

    const result = await decodeOtlpBody(c, decodeMetrics);
    if (result instanceof Response) return result;
    const { body } = result;

    // ADR 0032: Ingest metrics to TelemetryStore
    const telemetryMetrics = extractTelemetryMetrics(body);
    if (telemetryMetrics.length > 0) {
      await telemetryStore.ingestMetrics(telemetryMetrics);
    }

    // Use TelemetryMetric results for incident matching via shouldAttachEvidence.
    // TelemetryMetric has { service, environment, startTimeMs } — structurally compatible.
    if (telemetryMetrics.length > 0) {
      const page = await storage.listIncidents({ limit: 100 });
      await Promise.all(
        page.items.flatMap((incident) => {
          if (!telemetryMetrics.some((m) => shouldAttachEvidence(m, incident))) return [];
          return [(async () => {
            await rebuildAndNotify(incident.incidentId, telemetryStore, storage, diagnosisDebouncer);
          })()];
        }),
      );
    }

    return c.json({ status: "ok" });
  });

  // OTLP logs — protobuf + JSON both accepted (ADR 0022).
  // Only WARN/ERROR/FATAL logs (severityNumber >= 13) are extracted and attached.
  app.post("/v1/logs", async (c) => {
    await maybeCleanup(telemetryStore);

    const result = await decodeOtlpBody(c, decodeLogs);
    if (result instanceof Response) return result;
    const { body } = result;

    // ADR 0032: Ingest logs to TelemetryStore
    const telemetryLogs = await extractTelemetryLogs(body);
    if (telemetryLogs.length > 0) {
      await telemetryStore.ingestLogs(telemetryLogs);
    }

    // Use TelemetryLog results for incident matching via shouldAttachEvidence.
    // TelemetryLog has { service, environment, startTimeMs } — structurally compatible.
    if (telemetryLogs.length > 0) {
      const page = await storage.listIncidents({ limit: 100 });
      await Promise.all(
        page.items.flatMap((incident) => {
          if (!telemetryLogs.some((l) => shouldAttachEvidence(l, incident))) return [];
          return [(async () => {
            await rebuildAndNotify(incident.incidentId, telemetryStore, storage, diagnosisDebouncer);
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
      await storage.appendPlatformEvents(incidentId, events);
      await rebuildAndNotify(incidentId, telemetryStore, storage, diagnosisDebouncer);
    }

    return c.json({ status: "ok" });
  });

  return app;
}
