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

    // Find existing open incident for this formation key within window
    const page = await storage.listIncidents({ limit: 100 });
    const existing = page.items.find((incident) =>
      shouldAttachToIncident(formationKey, incident, signalTimeMs),
    );

    let incidentId: string;
    let openedAt: string;
    let isNew: boolean;

    if (existing) {
      isNew = false;
      incidentId = existing.incidentId;
      openedAt = existing.openedAt;
    } else {
      isNew = true;
      incidentId = "inc_" + randomUUID();
      openedAt = new Date().toISOString();
    }

    const packet = createPacket(incidentId, openedAt, anomalousSpans);
    await storage.createIncident(packet);

    if (isNew) {
      await storage.saveThinEvent({
        event_id: "evt_" + randomUUID(),
        event_type: "incident.created",
        incident_id: incidentId,
        packet_id: packet.packetId,
      });
    }

    return c.json({ status: "ok", incidentId, packetId: packet.packetId });
  });

  // Phase C: merge into packet evidence
  app.post("/v1/metrics", async (c) => {
    await c.req.json().catch(() => null);
    return c.json({ status: "ok" });
  });

  // Phase C: merge into packet evidence
  app.post("/v1/logs", async (c) => {
    await c.req.json().catch(() => null);
    return c.json({ status: "ok" });
  });

  // Phase C: merge into packet evidence
  app.post("/v1/platform-events", async (c) => {
    await c.req.json().catch(() => null);
    return c.json({ status: "ok" });
  });

  return app;
}
