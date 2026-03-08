import { Hono } from "hono";
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
  app.route("/", createIngestRouter(store));
  app.route("/", createApiRouter(store));
  return app;
}
