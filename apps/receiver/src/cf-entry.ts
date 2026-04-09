/**
 * Cloudflare Workers entry point.
 *
 * Mirrors vercel-entry.ts: lazy init, D1 adapter for storage + telemetry.
 *
 * - Lazy init: D1StorageAdapter + migrate runs once per isolate lifetime
 * - AUTH_TOKEN: resolved from D1 (auto-generated on first cold start) or env var
 * - Diagnosis: incidents are enqueued to Cloudflare Queues and processed by the queue consumer
 * - Console SPA is NOT served — use CF Pages for static hosting
 * - process.env is populated from bindings for createApp() compatibility
 */
import type { Hono } from "hono";
import { createApp, resolveAuthToken, WsBridgeManager } from "./index.js";
import type { BridgeWsConnection } from "./transport/ws-bridge.js";
import { runIfNeeded, setRequestWaitUntil } from "./runtime/diagnosis-debouncer.js";
import type { DiagnosisQueueMessage } from "./runtime/diagnosis-dispatch.js";
import { DiagnosisRunner } from "./runtime/diagnosis-runner.js";
import { D1StorageAdapter } from "./storage/drizzle/d1.js";
import { D1TelemetryAdapter } from "./telemetry/drizzle/d1.js";

// Local CF types to avoid @cloudflare/workers-types polluting globals
interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: unknown[]): Promise<T[]>;
  exec(query: string): Promise<unknown>;
  dump(): Promise<ArrayBuffer>;
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<{ meta?: { changes?: number } }>;
}
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  props: Record<string, unknown>;
}
interface QueueBinding<T> {
  send(message: T, options?: { delaySeconds?: number }): Promise<void>;
}
interface QueueMessage<T> {
  body: T;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}
interface MessageBatch<T> {
  messages: Array<QueueMessage<T>>;
}
// CF Workers WebSocket types (#331)
interface CfWebSocket {
  accept(): void;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", handler: (event: MessageEvent) => void): void;
  addEventListener(type: "close", handler: (event: CloseEvent) => void): void;
  addEventListener(type: "error", handler: (event: Event) => void): void;
}
declare class WebSocketPair {
  0: CfWebSocket;
  1: CfWebSocket;
}

interface Env {
  DB: D1Database;
  DIAGNOSIS_QUEUE?: QueueBinding<DiagnosisQueueMessage>;
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

interface RuntimeServices {
  app: Hono;
  storage: D1StorageAdapter;
  diagnosisRunner: DiagnosisRunner;
  wsBridge: WsBridgeManager;
  authToken: string | null;
}

let cachedRuntime: Promise<RuntimeServices> | null = null;
let cachedDbId: string | null = null;
let cachedEnvSignature: string | null = null;

export function _resetRuntimeForTest(): void {
  cachedRuntime = null;
  cachedDbId = null;
  cachedEnvSignature = null;
}

function getEnvSignature(env: Env): string {
  return JSON.stringify({
    authToken: env.RECEIVER_AUTH_TOKEN ?? "",
    allowInsecure: env.ALLOW_INSECURE_DEV_MODE ?? "",
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
    diagnosisQueue: Boolean(env.DIAGNOSIS_QUEUE),
  });
}

/**
 * Populate process.env from CF bindings so that createApp() and other modules
 * that read process.env work without changes.
 */
function populateProcessEnv(env: Env): void {
  process.env["THREEAM_RUNTIME"] = "cloudflare-workers";
  process.env["SELF_OTEL_ENABLED"] = "true";
  process.env["SELF_OTEL_CONSOLE_LOGS"] = "true";
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      process.env[key] = value;
    }
  }
}

async function getRuntime(env: Env): Promise<RuntimeServices> {
  // Re-init if D1 binding identity changes (e.g. wrangler dev restart)
  const dbId = (env.DB as unknown as { _id?: string })?._id ?? "default";
  const envSignature = getEnvSignature(env);
  if (cachedRuntime && cachedDbId === dbId && cachedEnvSignature === envSignature) return cachedRuntime;

  cachedDbId = dbId;
  cachedEnvSignature = envSignature;
  cachedRuntime = (async () => {
    populateProcessEnv(env);

    const storage = new D1StorageAdapter(env.DB);
    await storage.migrate();

    const telemetryStore = new D1TelemetryAdapter(env.DB);
    await telemetryStore.migrate();

    const resolvedAuthToken = await resolveAuthToken(storage);
    const diagnosisRunner = new DiagnosisRunner(storage, telemetryStore);
    const wsBridge = new WsBridgeManager();
    const enqueueDiagnosis = env.DIAGNOSIS_QUEUE
      ? async (incidentId: string, mode: DiagnosisQueueMessage["mode"] = "diagnosis", delaySeconds?: number) => {
          await env.DIAGNOSIS_QUEUE!.send({ incidentId, mode }, delaySeconds ? { delaySeconds } : undefined);
        }
      : undefined;

    return {
      app: createApp(storage, {
        telemetryStore,
        resolvedAuthToken,
        enqueueDiagnosis,
        wsBridge,
      }),
      storage,
      diagnosisRunner,
      wsBridge,
      authToken: resolvedAuthToken,
    };
  })();

  return cachedRuntime;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Ensure env is available for modules reading process.env during request handling
    populateProcessEnv(env);
    // Inject CF Workers ctx.waitUntil so diagnosis-debouncer can extend isolate lifetime
    setRequestWaitUntil((p) => ctx.waitUntil(p));
    const runtime = await getRuntime(env);

    // Handle WebSocket upgrade for /bridge/ws (#331)
    const url = new URL(request.url);
    if (url.pathname === "/bridge/ws" && request.headers.get("Upgrade") === "websocket") {
      // Auth: validate token from query param.
      // Note: query params can appear in proxy/platform logs. This is a known
      // tradeoff — WebSocket upgrade requests don't reliably support custom
      // headers across all environments. A future improvement could use a
      // short-lived ticket obtained via an authenticated HTTP endpoint.
      const queryToken = url.searchParams.get("token");
      if (runtime.authToken && queryToken !== runtime.authToken) {
        return new Response("unauthorized", { status: 401 });
      }

      // Create WebSocket pair (CF Workers native API)
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];

      // Accept the server side
      server.accept();

      // Create a WSContext-compatible wrapper for the bridge manager
      const wsContext = {
        send: (data: string | ArrayBuffer) => {
          try { server.send(data); } catch { /* connection may have closed */ }
        },
        close: (code?: number, reason?: string) => {
          try { server.close(code, reason); } catch { /* already closed */ }
        },
      };

      runtime.wsBridge.setConnection(wsContext as BridgeWsConnection);

      server.addEventListener("message", (event: MessageEvent) => {
        const data = typeof event.data === "string" ? event.data : event.data as ArrayBuffer;
        runtime.wsBridge.handleMessage(data);
      });

      server.addEventListener("close", () => {
        runtime.wsBridge.removeConnection(wsContext as BridgeWsConnection);
      });

      server.addEventListener("error", () => {
        runtime.wsBridge.removeConnection(wsContext as BridgeWsConnection);
      });

      // CF Workers-specific Response init with webSocket property
      return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: CfWebSocket });
    }

    return runtime.app.fetch(request, env, ctx);
  },
  async queue(batch: MessageBatch<DiagnosisQueueMessage>, env: Env): Promise<void> {
    const runtime = await getRuntime(env);

    for (const message of batch.messages) {
      const incidentId = message.body?.incidentId;
      if (typeof incidentId !== "string" || incidentId.length === 0) {
        message.ack();
        continue;
      }

      try {
        const mode = message.body?.mode ?? "diagnosis";
        if (mode === "narrative") {
          const ok = await runtime.diagnosisRunner.rerunNarrative(incidentId);
          if (!ok) {
            message.retry({ delaySeconds: 30 });
            continue;
          }
          message.ack();
          continue;
        }

        const outcome = await runIfNeeded(incidentId, runtime.storage, runtime.diagnosisRunner);
        if (outcome === "failed") {
          message.retry({ delaySeconds: 30 });
          continue;
        }
        message.ack();
      } catch (error) {
        console.error(`[cf-queue] diagnosis failed for ${incidentId}:`, error);
        message.retry({ delaySeconds: 30 });
      }
    }
  },
};
