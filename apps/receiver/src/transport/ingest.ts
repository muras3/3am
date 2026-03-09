import { randomUUID } from "crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { StorageDriver } from "../storage/interface.js";
import {
  extractSpans,
  isAnomalous,
} from "../domain/anomaly-detector.js";
import {
  buildFormationKey,
  shouldAttachToIncident,
} from "../domain/formation.js";
import { createPacket } from "../domain/packetizer.js";
import { dispatchThinEvent } from "../runtime/github-dispatch.js";

const INGEST_BODY_LIMIT = 1 * 1024 * 1024; // 1MB per ADR 0022 (resource exhaustion protection)

export function createIngestRouter(storage: StorageDriver): Hono {
  const app = new Hono();

  app.use(
    "*",
    bodyLimit({
      maxSize: INGEST_BODY_LIMIT,
      onError: (c) => c.json({ error: "payload too large" }, 413),
    }),
  );

  app.post("/v1/traces", async (c) => {
    const body = await c.req.json();

    const spans = extractSpans(body);
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

  // shape-aware stubs for metrics, logs, and platform events.
  // Validates Content-Type and basic body shape; returns 501 for protobuf (ADR 0022 Phase E).
  // Phase C: merge parsed signals into packet evidence.
  const ingestStubs = [
    { path: "/v1/metrics" as const, field: "resourceMetrics" },
    { path: "/v1/logs" as const, field: "resourceLogs" },
    { path: "/v1/platform-events" as const, field: "events" },
  ];
  for (const { path, field } of ingestStubs) {
    app.post(path, async (c) => {
      const ct = c.req.header("Content-Type") ?? "";
      if (ct.includes("application/x-protobuf")) {
        // TODO (Phase E): implement OTLP protobuf parsing (ADR 0022 protobuf-first)
        return c.json({ error: "protobuf not yet supported" }, 501);
      }
      const body = await c.req.json().catch(() => null);
      if (body === null || typeof body !== "object") {
        return c.json({ error: "invalid body" }, 400);
      }
      if (!(field in (body as Record<string, unknown>))) {
        return c.json({ error: `missing required field: ${field}` }, 400);
      }
      return c.json({ status: "ok" });
    });
  }

  return app;
}
