/**
 * Vercel Serverless Function entry point.
 *
 * Uses named HTTP method exports (GET, POST) required by @vercel/node
 * with Web Standard API. Calls Hono's app.fetch() directly instead of
 * hono/vercel handle() which relies on unsupported export default.
 *
 * - Lazy init: PostgresAdapter + migrate runs once per cold start
 * - AUTH_TOKEN: resolved from DB or env var; fail-closed if neither exists
 * - Diagnosis debouncer uses waitUntil (@vercel/functions) for serverless-safe deferred execution
 * - consoleDist NOT passed — Vercel serves console SPA as static files
 * - server.ts (Node.js entry) is preserved for local/Docker use
 * - BridgeJobQueue: in-memory job queue for manual mode evidence query / chat.
 *   Fluid Compute ensures the same instance handles concurrent requests,
 *   so enqueue + poll requests share the module-level queue.
 */
import type { Hono } from "hono";
import { createApp, resolveAuthToken, BridgeJobQueue } from "./index.js";
import { createPostgresClient } from "./storage/drizzle/postgres-client.js";
import { PostgresAdapter } from "./storage/drizzle/postgres.js";
import { PostgresTelemetryAdapter } from "./telemetry/drizzle/postgres.js";

/** Module-level singleton — shared across concurrent Fluid Compute requests. */
const bridgeJobQueue = new BridgeJobQueue();

let appPromise: Promise<Hono> | null = null;

async function getApp(): Promise<Hono> {
  if (!appPromise) {
    appPromise = (async () => {
      let storage: PostgresAdapter | undefined;
      let telemetryStore: PostgresTelemetryAdapter | undefined;

      if (process.env["DATABASE_URL"]) {
        const sharedClient = createPostgresClient();
        storage = new PostgresAdapter(sharedClient);
        await storage.migrate();
        telemetryStore = new PostgresTelemetryAdapter(sharedClient);
        await telemetryStore.migrate();
      }

      const resolvedAuthToken = storage
        ? await resolveAuthToken(storage)
        : null;

      return createApp(storage, { telemetryStore, resolvedAuthToken, bridgeJobQueue });
    })();
  }
  return appPromise;
}

async function handleRequest(request: Request): Promise<Response> {
  const app = await getApp();
  return app.fetch(request);
}

export const GET = handleRequest;
export const POST = handleRequest;
export const PUT = handleRequest;
export const PATCH = handleRequest;
export const DELETE = handleRequest;
export const OPTIONS = handleRequest;
