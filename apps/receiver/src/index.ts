import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import type { StorageDriver } from "./storage/interface.js";
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
    const allowInsecure = process.env["ALLOW_INSECURE_DEV_MODE"] === "true";
    if (!allowInsecure) {
      throw new Error(
        "[receiver] RECEIVER_AUTH_TOKEN must be set. " +
          "For local dev only, set ALLOW_INSECURE_DEV_MODE=true (ADR 0011)",
      );
    }
    console.warn("[receiver] auth disabled — ALLOW_INSECURE_DEV_MODE=true (dev only, ADR 0011)");
  } else {
    app.use("*", bearerAuth({ token: authToken }));
  }
  app.route("/", createIngestRouter(store));
  app.route("/", createApiRouter(store));
  return app;
}
