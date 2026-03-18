/**
 * Vercel Serverless Function entry point.
 *
 * Thin wrapper around createApp() using hono/vercel adapter.
 * - Lazy init: PostgresAdapter + migrate runs once per cold start
 * - consoleDist NOT passed — Vercel serves console SPA as static files
 * - server.ts (Node.js entry) is preserved for local/Docker use
 */
import { handle } from "hono/vercel";
import { createApp } from "./index.js";
import { PostgresAdapter } from "./storage/drizzle/postgres.js";
import { PostgresTelemetryAdapter } from "./telemetry/drizzle/postgres.js";

type Handler = (req: Request, requestContext?: { waitUntil?: (p: Promise<unknown>) => void }) => Response | Promise<Response>;

let handlerPromise: Promise<Handler> | null = null;

async function init(): Promise<Handler> {
  let storage: PostgresAdapter | undefined;
  let telemetryStore: PostgresTelemetryAdapter | undefined;

  if (process.env["DATABASE_URL"]) {
    storage = new PostgresAdapter();
    await storage.migrate();
    telemetryStore = new PostgresTelemetryAdapter();
    await telemetryStore.migrate();
  }

  const app = createApp(storage, { telemetryStore });
  return handle(app);
}

export default async function handler(req: Request, requestContext?: { waitUntil?: (p: Promise<unknown>) => void }): Promise<Response> {
  handlerPromise ??= init();
  const h = await handlerPromise;
  return h(req, requestContext);
}
