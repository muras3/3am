import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { cors } from "hono/cors";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { StorageDriver } from "./storage/interface.js";
import type { TelemetryStoreDriver } from "./telemetry/interface.js";
import { MemoryAdapter } from "./storage/adapters/memory.js";
import { MemoryTelemetryAdapter } from "./telemetry/adapters/memory.js";
import { createIngestRouter } from "./transport/ingest.js";
import { createApiRouter, type BridgeDoForwarder } from "./transport/api.js";
import { SpanBuffer } from "./ambient/span-buffer.js";
import type { DiagnosisConfig } from "./runtime/diagnosis-debouncer.js";
import { DiagnosisRunner } from "./runtime/diagnosis-runner.js";
import type { EnqueueDiagnosisFn } from "./runtime/diagnosis-dispatch.js";
import { PROVIDER_NAMES } from "3am-diagnosis";
import {
  getReceiverLlmSettings,
  SETTINGS_KEY_DIAGNOSIS_MODE,
  SETTINGS_KEY_DIAGNOSIS_PROVIDER,
  SETTINGS_KEY_LLM_BRIDGE_URL,
} from "./runtime/llm-settings.js";
import { emitSelfTelemetryLog, isSelfTelemetryActive } from "./self-telemetry/log.js";
import { recordSelfTelemetryMetrics } from "./self-telemetry/metrics.js";
import type { WsBridgeManager } from "./transport/ws-bridge.js";
import type { BridgeJobQueue } from "./runtime/bridge-job-queue.js";
import { sessionOrBearerAuth } from "./middleware/session-cookie.js";

export type { StorageDriver } from "./storage/interface.js";
export type { Incident, IncidentPage } from "./storage/interface.js";
export { MemoryAdapter } from "./storage/adapters/memory.js";
export type { TelemetryStoreDriver } from "./telemetry/interface.js";
export { WsBridgeManager } from "./transport/ws-bridge.js";
export type { BridgeDoForwarder } from "./transport/api.js";
export { BridgeJobQueue } from "./runtime/bridge-job-queue.js";

const SETTINGS_KEY_AUTH_TOKEN = "receiver_auth_token";
const SETTINGS_KEY_SETUP_COMPLETE = "setup_complete";
const SETTINGS_KEY_LOCALE = "locale";
const SUPPORTED_LOCALES = ["en", "ja"] as const;

const APP_VERSION: string = process.env["npm_package_version"] ?? "0.1.0";

/**
 * Resolve the auth token for this instance.
 * Priority: RECEIVER_AUTH_TOKEN env var > DB-stored token.
 * In dev mode (ALLOW_INSECURE_DEV_MODE=true), returns null (auth skipped).
 */
export async function resolveAuthToken(storage: StorageDriver): Promise<string | null> {
  const allowInsecure = process.env["ALLOW_INSECURE_DEV_MODE"] === "true";
  if (allowInsecure) return null;

  const envToken = process.env["RECEIVER_AUTH_TOKEN"];
  if (envToken) return envToken;

  const stored = await storage.getSettings(SETTINGS_KEY_AUTH_TOKEN);
  if (stored) return stored;

  throw new Error(
    "[receiver] No auth token available. Configure RECEIVER_AUTH_TOKEN before exposing the receiver publicly.",
  );
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
  enqueueDiagnosis?: EnqueueDiagnosisFn | undefined;
  /** WebSocket bridge manager for remote manual mode (#331). */
  wsBridge?: WsBridgeManager | undefined;
  /** Durable Object bridge forwarder for CF Workers (#331). */
  bridgeDoForwarder?: BridgeDoForwarder | undefined;
  /** Returns whether the DO bridge has a connected WebSocket. CF Workers only. */
  bridgeDoStatus?: () => Promise<boolean>;
  /** In-memory bridge job queue for Vercel Fluid Compute long-poll. */
  bridgeJobQueue?: BridgeJobQueue | undefined;
}

export function createApp(storage?: StorageDriver, options?: AppOptions): Hono {
  const store = storage ?? new MemoryAdapter();
  const app = new Hono();
  const allowInsecure = process.env["ALLOW_INSECURE_DEV_MODE"] === "true";

  if (isSelfTelemetryActive()) {
    const tracer = trace.getTracer("3am.receiver.self");
    app.use("*", async (c, next) => {
      return tracer.startActiveSpan(
        `${c.req.method} ${c.req.path}`,
        {
          kind: SpanKind.SERVER,
          attributes: {
            "3am.telemetry.stream": "self",
            "http.route": c.req.path,
            "http.request.method": c.req.method,
            "url.path": new URL(c.req.url).pathname,
          },
        },
        async (span) => {
          const startedAt = Date.now();
          let failed = false;
          try {
            await next();
          } catch (error) {
            failed = true;
            span.recordException(error instanceof Error ? error : new Error(String(error)));
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw error;
          } finally {
            const url = new URL(c.req.url);
            const status = failed ? 500 : c.res.status;
            const durationMs = Date.now() - startedAt;
            span.setAttributes({
              "http.response.status_code": status,
              "server.address": url.hostname,
              "server.port": Number(url.port || (url.protocol === "https:" ? 443 : 80)),
              "3am.request.duration_ms": durationMs,
            });
            if (status >= 400 && !failed) {
              span.setStatus({ code: SpanStatusCode.ERROR });
            }
            recordSelfTelemetryMetrics({
              method: c.req.method,
              route: c.req.path,
              statusCode: status,
              durationMs,
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
                "3am.request.duration_ms": durationMs,
              },
            });
            span.end();
          }
        },
      );
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
      attributes: { "3am.receiver.event": "auth-disabled-dev-mode" },
    });
  } else {
    // Deferred setup completion: mark setup as done on first authenticated
    // request, not on token fetch. Allows re-fetching if post-setup fails. (#236)
    let setupMarkedComplete = false;
    const markSetupComplete = async () => {
      if (setupMarkedComplete) return;
      setupMarkedComplete = true;
      await store.setSettings(SETTINGS_KEY_SETUP_COMPLETE, "true").catch(() => {});
    };

    // /v1/*: OTel SDK ingest — requires Bearer token
    app.use("/v1/*", async (c, next) => {
      const result = await bearerAuth({ token: authToken })(c, next);
      if (c.res.ok) await markSetupComplete();
      return result;
    });
    // /api/*: Console API — requires session cookie or Bearer token.
    app.use("/api/*", async (c, next) => {
      // Exempt only explicitly public bootstrap endpoints.
      if (
        c.req.path === "/api/setup-status" ||
        c.req.path === "/api/claims/exchange" ||
        c.req.path === "/api/settings/locale"
      ) {
        return next();
      }
      const result = await sessionOrBearerAuth(authToken)(c, next);
      if (c.res.ok) await markSetupComplete();
      return result;
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
    generationThreshold: parseEnvInt(process.env["DIAGNOSIS_GENERATION_THRESHOLD"], 15),
    maxWaitMs: parseEnvInt(process.env["DIAGNOSIS_MAX_WAIT_MS"], 30000),
  };

  // Setup endpoints (public, no auth required) — must be registered before API router

  app.get("/api/setup-status", async (c) => {
    const setupComplete = (await store.getSettings(SETTINGS_KEY_SETUP_COMPLETE)) === "true";
    return c.json({
      setupComplete,
      authRequired: Boolean(authToken),
      bootstrapMethod: authToken ? "claim" : "none",
    });
  });

  // Locale settings endpoints (public, no auth — like setup-status)
  app.get("/api/settings/locale", async (c) => {
    const locale = await store.getSettings(SETTINGS_KEY_LOCALE);
    return c.json({ locale: locale ?? "en" });
  });

  app.put("/api/settings/locale", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }
    if (typeof body !== "object" || body === null) {
      return c.json({ error: "invalid body" }, 400);
    }
    const locale = (body as Record<string, unknown>)["locale"];
    if (typeof locale !== "string" || !(SUPPORTED_LOCALES as readonly string[]).includes(locale)) {
      return c.json({ error: `locale must be one of: ${SUPPORTED_LOCALES.join(", ")}` }, 400);
    }
    await store.setSettings(SETTINGS_KEY_LOCALE, locale);
    return c.json({ locale });
  });

  app.get("/api/settings/diagnosis", async (c) => {
    return c.json(await getReceiverLlmSettings(store));
  });

  app.put("/api/settings/diagnosis", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }
    if (typeof body !== "object" || body === null) {
      return c.json({ error: "invalid body" }, 400);
    }

    const mode = (body as Record<string, unknown>)["mode"];
    const provider = (body as Record<string, unknown>)["provider"];
    const bridgeUrl = (body as Record<string, unknown>)["bridgeUrl"];

    if (mode !== "automatic" && mode !== "manual") {
      return c.json({ error: "mode must be 'automatic' or 'manual'" }, 400);
    }
    await store.setSettings(SETTINGS_KEY_DIAGNOSIS_MODE, mode);

    if (provider !== undefined && provider !== null) {
      if (typeof provider !== "string" || !(PROVIDER_NAMES as readonly string[]).includes(provider)) {
        return c.json({ error: `provider must be one of: ${PROVIDER_NAMES.join(", ")}` }, 400);
      }
      await store.setSettings(SETTINGS_KEY_DIAGNOSIS_PROVIDER, provider);
    }

    if (bridgeUrl !== undefined && bridgeUrl !== null) {
      if (typeof bridgeUrl !== "string" || bridgeUrl.trim().length === 0) {
        return c.json({ error: "bridgeUrl must be a non-empty string" }, 400);
      }
      await store.setSettings(SETTINGS_KEY_LLM_BRIDGE_URL, bridgeUrl);
    }

    return c.json(await getReceiverLlmSettings(store));
  });

  // WebSocket bridge manager for remote manual mode (#331)
  const wsBridge = options?.wsBridge;

  app.route("/", createIngestRouter(store, spanBuffer, telemetryStore, diagnosisConfig, runner, options?.enqueueDiagnosis));
  app.route("/", createApiRouter(store, spanBuffer, telemetryStore, diagnosisConfig, runner, options?.enqueueDiagnosis, wsBridge, options?.bridgeDoForwarder, options?.bridgeJobQueue));

  // Bridge status endpoint — protected by Bearer auth (under /api/*)
  const bridgeDoStatus = options?.bridgeDoStatus;
  app.get("/api/bridge/status", async (c) => {
    if (wsBridge?.isConnected()) {
      return c.json({ connected: true });
    }
    if (bridgeDoStatus) {
      const connected = await bridgeDoStatus();
      return c.json({ connected });
    }
    return c.json({ connected: false });
  });

  return app;
}
