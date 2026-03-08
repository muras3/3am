import { Hono } from "hono";
import { DiagnosisResultSchema } from "@3amoncall/core";
import type { StorageDriver } from "../storage/interface.js";

export function createApiRouter(storage: StorageDriver): Hono {
  const app = new Hono();

  app.get("/api/incidents", async (c) => {
    const limitStr = c.req.query("limit");
    const cursor = c.req.query("cursor");
    const limit = limitStr !== undefined ? parseInt(limitStr, 10) : 20;

    const page = await storage.listIncidents({ limit, cursor });
    return c.json(page);
  });

  app.get("/api/incidents/:id", async (c) => {
    const id = c.req.param("id");
    const incident = await storage.getIncident(id);
    if (incident === null) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(incident);
  });

  app.get("/api/packets/:packetId", async (c) => {
    const packetId = c.req.param("packetId");
    // Phase C: add packetId index to StorageDriver for O(1) access
    const page = await storage.listIncidents({ limit: 1000 });
    const incident = page.items.find(
      (inc) => inc.packet.packetId === packetId,
    );
    if (!incident) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(incident.packet);
  });

  app.post("/api/diagnosis/:id", async (c) => {
    const id = c.req.param("id");

    let result;
    try {
      const body = await c.req.json();
      result = DiagnosisResultSchema.parse(body);
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }

    if (result.metadata.incident_id !== id) {
      return c.json(
        { error: "metadata.incident_id does not match path param" },
        400,
      );
    }

    const incident = await storage.getIncident(id);
    if (incident === null) {
      return c.json({ error: "not found" }, 404);
    }

    await storage.appendDiagnosis(id, result);
    return c.json({ status: "ok" });
  });

  return app;
}
