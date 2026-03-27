import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { cors } from "hono/cors";
import { trace } from "@opentelemetry/api";
import type { StorageDriver } from "./storage/interface.js";
import type { TelemetryStoreDriver } from "./telemetry/interface.js";
import { MemoryAdapter } from "./storage/adapters/memory.js";
import { MemoryTelemetryAdapter } from "./telemetry/adapters/memory.js";
import { createIngestRouter } from "./transport/ingest.js";
import { createApiRouter } from "./transport/api.js";
import { SpanBuffer } from "./ambient/span-buffer.js";
import type { DiagnosisConfig } from "./runtime/diagnosis-debouncer.js";
import { DiagnosisRunner } from "./runtime/diagnosis-runner.js";
import { emitSelfTelemetryLog, isSelfTelemetryActive } from "./self-telemetry/log.js";

export type { StorageDriver } from "./storage/interface.js";
export type { Incident, IncidentPage } from "./storage/interface.js";
export { MemoryAdapter } from "./storage/adapters/memory.js";
export type { TelemetryStoreDriver } from "./telemetry/interface.js";

const SETTINGS_KEY_AUTH_TOKEN = "receiver_auth_token";
const SETTINGS_KEY_SETUP_COMPLETE = "setup_complete";

const APP_VERSION: string = process.env["npm_package_version"] ?? "0.1.0";

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

  const generated = crypto.randomUUID();
  await storage.setSettings(SETTINGS_KEY_AUTH_TOKEN, generated);
  emitSelfTelemetryLog({
    severity: "INFO",
    body: "[receiver] generated new auth token",
    attributes: { "3amoncall.receiver.event": "auth-token-generated" },
  });
  return generated;
}

export interface AppOptions {
  /** SpanBuffer instance for the ambient read model (ADR 0029). */
  spanBuffer?: SpanBuffer | undefined;
  /** TelemetryStore instance for scored evidence selection (ADR 0032).
   *  When not provided, a MemoryTelemetryAdapter is auto-created (DJ-3).
   */
  telemetryStore?: TelemetryStoreDriver | undefined;
  /**
   * Pre-resolved auth token from resolveAuthToken().
   * When provided, createApp skips env-var lookup and uses this directly.
   */
  resolvedAuthToken?: string | null | undefined;
}

export function createApp(storage?: StorageDriver, options?: AppOptions): Hono {
  const store = storage ?? new MemoryAdapter();
  const app = new Hono();
  const allowInsecure = process.env["ALLOW_INSECURE_DEV_MODE"] === "true";

  if (isSelfTelemetryActive()) {
    app.use("*", async (c, next) => {
      const startedAt = Date.now();
      let failed = false;
      try {
        await next();
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        const url = new URL(c.req.url);
        const status = failed ? 500 : c.res.status;
        const durationMs = Date.now() - startedAt;
        const span = trace.getActiveSpan();
        span?.setAttributes({
          "3amoncall.telemetry.stream": "self",
          "http.route": c.req.path,
          "http.request.method": c.req.method,
          "http.response.status_code": status,
          "url.path": url.pathname,
        });
        emitSelfTelemetryLog({
          severity: status >= 500 ? "ERROR" : status >= 400 ? "WARN" : "INFO",
          body: "receiver.request",
          attributes: {
            "http.request.method": c.req.method,
            "http.route": c.req.path,
            "http.response.status_code": status,
            "url.path": url.pathname,
            "server.address": url.hostname,
            "server.port": Number(url.port || (url.protocol === "https:" ? 443 : 80)),
            "3amoncall.request.duration_ms": durationMs,
          },
        });
      }
    });
  }

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
    if (!allowInsecure) {
      c.res.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
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
    emitSelfTelemetryLog({
      severity: "WARN",
      body: "[receiver] auth disabled for insecure dev mode",
      attributes: { "3amoncall.receiver.event": "auth-disabled-dev-mode" },
    });
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
  const runner = new DiagnosisRunner(store, telemetryStore);

  // Diagnosis quiet period: defer diagnosis until evidence accumulates.
  // Dual trigger: generation threshold OR max wait time (whichever fires first).
  // Uses waitUntil (Vercel) or fire-and-forget (local) for serverless-safe deferred execution.
  const parseEnvInt = (v: string | undefined, fallback: number) => {
    const n = parseInt(v ?? String(fallback), 10);
    return Number.isNaN(n) ? fallback : n;
  };
  const diagnosisConfig: DiagnosisConfig = {
    generationThreshold: parseEnvInt(process.env["DIAGNOSIS_GENERATION_THRESHOLD"], 50),
    maxWaitMs: parseEnvInt(process.env["DIAGNOSIS_MAX_WAIT_MS"], 180000),
  };

  // Setup endpoints (public, no auth required) — must be registered before API router

  app.get("/api/setup-status", async (c) => {
    // env var mode: token is set via RECEIVER_AUTH_TOKEN, not generated by DB.
    // In this case, setup is always "complete" — user enters token via recovery flow.
    if (authToken && !(await store.getSettings(SETTINGS_KEY_AUTH_TOKEN))) {
      return c.json({ setupComplete: true });
    }
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

  app.route("/", createIngestRouter(store, spanBuffer, telemetryStore, diagnosisConfig, runner));
  app.route("/", createApiRouter(store, spanBuffer, telemetryStore, runner));

  return app;
}
