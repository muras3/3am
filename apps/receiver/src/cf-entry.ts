/**
 * Cloudflare Workers entry point.
 *
 * Mirrors vercel-entry.ts: lazy init, D1 adapter for storage + telemetry.
 *
 * - Lazy init: D1StorageAdapter + migrate runs once per isolate lifetime
 * - AUTH_TOKEN: resolved from D1 (auto-generated on first cold start) or env var
 * - Diagnosis: DIAGNOSIS_MAX_WAIT_MS=0 forces immediate inline diagnosis (no waitUntil for spike)
 * - Console SPA is NOT served — use CF Pages for static hosting
 * - process.env is populated from bindings for createApp() compatibility
 */
import type { Hono } from "hono";
import { createApp, resolveAuthToken } from "./index.js";
import { D1StorageAdapter } from "./storage/drizzle/d1.js";
import { D1TelemetryAdapter } from "./telemetry/drizzle/d1.js";

// Local CF types to avoid @cloudflare/workers-types polluting globals
interface D1Database {
  prepare(query: string): unknown;
  batch<T = unknown>(statements: unknown[]): Promise<T[]>;
  exec(query: string): Promise<unknown>;
  dump(): Promise<ArrayBuffer>;
}
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  props: Record<string, unknown>;
}

interface Env {
  DB: D1Database;
  RECEIVER_AUTH_TOKEN?: string;
  ALLOW_INSECURE_DEV_MODE?: string;
  CORS_ALLOWED_ORIGIN?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  CHAT_MODEL?: string;
  DIAGNOSIS_MODEL?: string;
  NARRATIVE_MODEL?: string;
  EVIDENCE_QUERY_MODEL?: string;
  DIAGNOSIS_GENERATION_THRESHOLD?: string;
  DIAGNOSIS_MAX_WAIT_MS?: string;
}

let cachedApp: Promise<Hono> | null = null;
let cachedDbId: string | null = null;

/**
 * Populate process.env from CF bindings so that createApp() and other modules
 * that read process.env work without changes.
 */
function populateProcessEnv(env: Env): void {
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      process.env[key] = value;
    }
  }
}

async function getApp(env: Env): Promise<Hono> {
  // Re-init if D1 binding identity changes (e.g. wrangler dev restart)
  const dbId = (env.DB as unknown as { _id?: string })?._id ?? "default";
  if (cachedApp && cachedDbId === dbId) return cachedApp;

  cachedDbId = dbId;
  cachedApp = (async () => {
    populateProcessEnv(env);

    const storage = new D1StorageAdapter(env.DB);
    await storage.migrate();

    const telemetryStore = new D1TelemetryAdapter(env.DB);
    await telemetryStore.migrate();

    const resolvedAuthToken = await resolveAuthToken(storage);

    return createApp(storage, { telemetryStore, resolvedAuthToken });
  })();

  return cachedApp;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Ensure env is available for modules reading process.env during request handling
    populateProcessEnv(env);
    const app = await getApp(env);
    return app.fetch(request, env, ctx);
  },
};
