import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import type { StorageDriver } from "./storage/interface.js";
import type { TelemetryStoreDriver } from "./telemetry/interface.js";
import { MemoryAdapter } from "./storage/adapters/memory.js";
import { MemoryTelemetryAdapter } from "./telemetry/adapters/memory.js";
import { createIngestRouter } from "./transport/ingest.js";
import { createApiRouter } from "./transport/api.js";
import { SpanBuffer } from "./ambient/span-buffer.js";
import { DiagnosisDebouncer } from "./runtime/diagnosis-debouncer.js";
import { DiagnosisRunner } from "./runtime/diagnosis-runner.js";

export type { StorageDriver } from "./storage/interface.js";
export type { Incident, IncidentPage } from "./storage/interface.js";
export { MemoryAdapter } from "./storage/adapters/memory.js";
export type { TelemetryStoreDriver } from "./telemetry/interface.js";

const SETTINGS_KEY_AUTH_TOKEN = "receiver_auth_token";
const SETTINGS_KEY_SETUP_COMPLETE = "setup_complete";

const APP_VERSION: string = (() => {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(dir, "../package.json"), "utf-8")).version;
  } catch {
    return process.env["npm_package_version"] ?? "0.0.0";
  }
})();

/**
 * Resolve the auth token for this instance.
 * Priority: RECEIVER_AUTH_TOKEN env var > DB-stored token > auto-generated (saved to DB).
 * In dev mode (ALLOW_INSECURE_DEV_MODE=true), returns null (auth skipped).
 */
export async function resolveAuthToken(storage: StorageDriver): Promise<string | null> {
  const allowInsecure = process.env["ALLOW_INSECURE_DEV_MODE"] === "true";
  if (allowInsecure) return null;

  const envToken = process.env["RECEIVER_AUTH_TOKEN"];
  if (envToken) return envToken;

  const stored = await storage.getSettings(SETTINGS_KEY_AUTH_TOKEN);
  if (stored) return stored;

  const generated = randomUUID();
  await storage.setSettings(SETTINGS_KEY_AUTH_TOKEN, generated);
  console.log("[receiver] Generated new auth token — retrieve via /api/setup-token on first access");
  return generated;
}

export interface AppOptions {
  /** Absolute path to the built Console dist directory. When set, Receiver serves
   *  the SPA at "/" and falls back to index.html for unknown paths.
   *  Can also be set via CONSOLE_DIST_PATH env var.
   */
  consoleDist?: string;
  /** SpanBuffer instance for the ambient read model (ADR 0029). */
  spanBuffer?: SpanBuffer;
  /** TelemetryStore instance for scored evidence selection (ADR 0032).
   *  When not provided, a MemoryTelemetryAdapter is auto-created (DJ-3).
   */
  telemetryStore?: TelemetryStoreDriver;
  /**
   * Pre-resolved auth token from resolveAuthToken().
   * When provided, createApp skips env-var lookup and uses this directly.
   */
  resolvedAuthToken?: string | null;
}

export function createApp(storage?: StorageDriver, options?: AppOptions): Hono {
  const store = storage ?? new MemoryAdapter();
  const app = new Hono();
  const allowInsecure = process.env["ALLOW_INSECURE_DEV_MODE"] === "true";

  // Health check — no auth, no CORS (infra-only)
  app.get("/healthz", (c) => c.json({ status: "ok", version: APP_VERSION }));

  // CORS middleware — must be registered before auth so preflight OPTIONS passes (ADR 0019 v2)
  const corsOrigin: string | undefined = allowInsecure
    ? "*"
    : process.env["CORS_ALLOWED_ORIGIN"];
  if (corsOrigin) {
    app.use("/*", cors({ origin: corsOrigin }));
  }
  // If corsOrigin is falsy (prod without CORS_ALLOWED_ORIGIN), no CORS header → same-origin only

  // Security headers — after CORS, before auth
  app.use("/*", async (c, next) => {
    await next();
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    c.res.headers.set("X-Frame-Options", "DENY");
    c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    c.res.headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com",
    );
  });

  // Auth token — use pre-resolved token if provided, otherwise fall back to env var
  const authToken: string | null | undefined =
    "resolvedAuthToken" in (options ?? {})
      ? options!.resolvedAuthToken
      : process.env["RECEIVER_AUTH_TOKEN"] ?? null;

  if (!authToken) {
    if (!allowInsecure) {
      throw new Error(
        "[receiver] No auth token available. " +
          "For local dev only, set ALLOW_INSECURE_DEV_MODE=true (ADR 0011)",
      );
    }
    console.warn("[receiver] auth disabled — ALLOW_INSECURE_DEV_MODE=true (dev only, ADR 0011)");
  } else {
    // /v1/*: OTel SDK ingest — requires Bearer token
    app.use("/v1/*", bearerAuth({ token: authToken }));
    // /api/setup-status and /api/setup-token are public (no auth) — registered before /api/* auth
    // /api/*: Console API — requires Bearer token (ADR 0034: inline diagnosis, no GitHub Actions)
    app.use("/api/*", async (c, next) => {
      // Exempt: setup endpoints (public), chat (uses session cookie auth instead)
      if (
        c.req.path === "/api/setup-status" ||
        c.req.path === "/api/setup-token" ||
        c.req.path.startsWith("/api/chat/")
      ) {
        return next();
      }
      return bearerAuth({ token: authToken })(c, next);
    });
  }

  // Auto-create SpanBuffer if not provided (ADR 0029: always active in production)
  const spanBuffer = options?.spanBuffer ?? new SpanBuffer();
  // Auto-create TelemetryStore if not provided (DJ-3: always available)
  const telemetryStore = options?.telemetryStore ?? new MemoryTelemetryAdapter();

  // DiagnosisRunner: inline LLM diagnosis (ADR 0034 — replaces GitHub Actions dispatch)
  const runner = new DiagnosisRunner(store);

  // Diagnosis quiet period: defer diagnosis until evidence accumulates.
  // Dual trigger: generation threshold OR max wait time (whichever fires first).
  // Both = 0 → immediate diagnosis (no debouncer).
  const parseEnvInt = (v: string | undefined, fallback: number) => {
    const n = parseInt(v ?? String(fallback), 10);
    return Number.isNaN(n) ? fallback : n;
  };
  const generationThreshold = parseEnvInt(process.env["DIAGNOSIS_GENERATION_THRESHOLD"], 50);
  const maxWaitMs = parseEnvInt(process.env["DIAGNOSIS_MAX_WAIT_MS"], 180000);
  const diagnosisDebouncer = (generationThreshold === 0 && maxWaitMs === 0)
    ? undefined
    : new DiagnosisDebouncer({
        generationThreshold: generationThreshold || Infinity,
        maxWaitMs: maxWaitMs || Infinity,
        onReady: (incidentId) => {
          void runner.run(incidentId);
        },
      });

  // Setup endpoints (public, no auth required) — must be registered before API router

  app.get("/api/setup-status", async (c) => {
    const setupComplete = (await store.getSettings(SETTINGS_KEY_SETUP_COMPLETE)) === "true";
    return c.json({ setupComplete });
  });

  app.get("/api/setup-token", async (c) => {
    const setupComplete = (await store.getSettings(SETTINGS_KEY_SETUP_COMPLETE)) === "true";
    if (setupComplete) {
      return c.json({ error: "setup already complete" }, 403);
    }

    const token = await store.getSettings(SETTINGS_KEY_AUTH_TOKEN);
    if (!token) {
      // env var mode or dev mode — no DB token
      return c.json({ error: "token not available (env var mode)" }, 404);
    }

    await store.setSettings(SETTINGS_KEY_SETUP_COMPLETE, "true");
    return c.json({ token });
  });

  app.route("/", createIngestRouter(store, spanBuffer, telemetryStore, diagnosisDebouncer, runner));
  app.route("/", createApiRouter(store, spanBuffer, telemetryStore));

  // Static serving for the Console SPA (ADR 0028)
  const consoleDist = options?.consoleDist ?? process.env["CONSOLE_DIST_PATH"];
  if (consoleDist) {
    // Cache index.html once at startup to avoid blocking the event loop per-request (F-E4-001)
    let indexHtml: string | null = null;
    try {
      indexHtml = readFileSync(join(consoleDist, "index.html"), "utf-8");
    } catch {
      console.warn("[receiver] Console index.html not found at", consoleDist, "— SPA fallback disabled");
    }

    // Serve static assets (JS, CSS, images) by path
    app.use("/*", serveStatic({ root: consoleDist }));
    // SPA fallback: unknown paths → cached index.html (client-side routing)
    if (indexHtml) {
      app.get("/*", (c) => c.html(indexHtml as string));
    }
  }

  return app;
}
