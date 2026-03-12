import { randomUUID } from "crypto";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { StorageDriver } from "../storage/interface.js";
import type { SpanBuffer } from "../ambient/span-buffer.js";
import {
  extractSpans,
  isAnomalous,
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
import { createPacket } from "../domain/packetizer.js";
import { dispatchThinEvent } from "../runtime/github-dispatch.js";
import { decodeTraces, decodeMetrics, decodeLogs } from "./otlp-protobuf.js";

const gunzipAsync = promisify(gunzip);

const INGEST_BODY_LIMIT = 1 * 1024 * 1024; // 1MB per ADR 0022 (resource exhaustion protection)

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
    const anomalousSpans = spans.filter(isAnomalous);

    if (anomalousSpans.length === 0) {
      return c.json({ status: "ok" });
    }

    const firstSpan = anomalousSpans[0];
    const formationKey = buildFormationKey(firstSpan);
    const signalTimeMs = firstSpan.startTimeMs;

    // Find existing open incident for this formation key within window.
    // Phase C: paginate through all pages (cursor loop) so matches are not
    // missed when there are >100 open incidents.
    const page = await storage.listIncidents({ limit: 100 });
    const existing = page.items.find((incident) =>
      shouldAttachToIncident(formationKey, incident, signalTimeMs),
    );

    const isNew = !existing;
    const incidentId = existing ? existing.incidentId : "inc_" + randomUUID();
    // Use signal time (not server clock) so formation window is anchored to telemetry
    const openedAt = existing
      ? existing.openedAt
      : new Date(firstSpan.startTimeMs).toISOString();

    if (isNew) {
      // Only create the packet (and emit ThinEvent) for new incidents.
      // Attaching to an existing incident does not overwrite the stored packet,
      // preserving the stable packet_id that was already emitted in the ThinEvent.
      // Phase C: accumulate evidence across signals via appendEvidence().
      // Pass all spans (not just anomalous) so the packet captures the full
      // incident-scoped evidence bundle per ADR 0016/0018 (affectedServices,
      // representativeTraces, traceRefs include healthy sibling spans).
      // triggerSignals is computed inside createPacket by re-filtering isAnomalous.
      const packet = createPacket(incidentId, openedAt, spans);
      await storage.createIncident(packet);
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
      // TODO Phase C: paginate through all pages (cursor loop) so matches are not
      // missed when there are >100 open incidents (same gap as /v1/traces path).
      const page = await storage.listIncidents({ limit: 100 });
      // NOTE: appendEvidence calls are parallelized across incidents.
      // Each call is a read-modify-write (2 DB round-trips); concurrent writes to
      // the same incident may cause lost updates if two metric/log batches arrive
      // simultaneously — under OTel Collector batch-processor concurrency this can
      // happen in practice and may silently discard evidence entries.
      // Acceptable in Phase 1 (Phase C: replace with atomic JSONB append).
      // Connection pool size (10) bounds effective concurrency for Postgres.
      await Promise.all(
        page.items.flatMap((incident) => {
          const matching = evidences.filter((e) => shouldAttachEvidence(e, incident));
          return matching.length > 0
            ? [storage.appendEvidence(incident.incidentId, { changedMetrics: matching })]
            : [];
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
      // TODO Phase C: paginate (same gap as /v1/metrics and /v1/traces paths).
      const page = await storage.listIncidents({ limit: 100 });
      // Same race/concurrency trade-off as /v1/metrics — see comment above.
      await Promise.all(
        page.items.flatMap((incident) => {
          const matching = evidences.filter((e) => shouldAttachEvidence(e, incident));
          return matching.length > 0
            ? [storage.appendEvidence(incident.incidentId, { relevantLogs: matching })]
            : [];
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
    if (!("events" in (body as Record<string, unknown>))) {
      return c.json({ error: "missing required field: events" }, 400);
    }
    return c.json({ status: "ok" });
  });

  return app;
}
