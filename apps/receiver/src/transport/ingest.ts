import { randomUUID } from "crypto";
import { Hono } from "hono";
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

export function createIngestRouter(storage: StorageDriver): Hono {
  const app = new Hono();

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
      await storage.saveThinEvent({
        event_id: "evt_" + randomUUID(),
        event_type: "incident.created",
        incident_id: incidentId,
        packet_id: packet.packetId,
      });
      return c.json({ status: "ok", incidentId, packetId: packet.packetId });
    }

    return c.json({ status: "ok", incidentId, packetId: existing.packet.packetId });
  });

  // Phase C: merge metrics/logs/platform-events into packet evidence
  for (const path of ["/v1/metrics", "/v1/logs", "/v1/platform-events"] as const) {
    app.post(path, async (c) => {
      await c.req.json().catch(() => null); // consume body for connection lifecycle
      return c.json({ status: "ok" });
    });
  }

  return app;
}
