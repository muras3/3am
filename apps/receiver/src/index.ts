import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { StorageDriver } from "./storage/interface.js";
import { MemoryAdapter } from "./storage/adapters/memory.js";
import { createIngestRouter } from "./transport/ingest.js";
import { createApiRouter } from "./transport/api.js";

export type { StorageDriver } from "./storage/interface.js";
export type { Incident, IncidentPage } from "./storage/interface.js";
export { MemoryAdapter } from "./storage/adapters/memory.js";

export function createApp(storage?: StorageDriver): Hono {
  const store = storage ?? new MemoryAdapter();
  const app = new Hono();
  const authToken = process.env["RECEIVER_AUTH_TOKEN"];
  if (!authToken) {
    console.warn(
      "[receiver] RECEIVER_AUTH_TOKEN not set — auth disabled (dev mode only, ADR 0011)",
    );
  } else {
    app.use("*", bearerAuth({ token: authToken }));
  }
  app.route("/", createIngestRouter(store));
  app.route("/", createApiRouter(store));
  return app;
}
