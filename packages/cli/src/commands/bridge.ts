import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ProviderName } from "3am-diagnosis";
// Dynamic import — claude-code-pool uses node:child_process and must not
// be statically imported (would crash CF Workers bundle via 3am-diagnosis).
async function primeClaudePool(model?: string): Promise<void> {
  try {
    const { prime } = await import("3am-diagnosis/claude-code-pool");
    await prime(model);
  } catch (err) {
    process.stderr.write(`[bridge] pool prime failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
async function shutdownClaudePool(): Promise<void> {
  try {
    const { shutdown } = await import("3am-diagnosis/claude-code-pool");
    shutdown();
  } catch { /* non-fatal */ }
}
import type { DiagnosisResult, EvidenceResponse } from "3am-core";
import { loadCredentials, findReceiverCredentialByUrl } from "./init/credentials.js";
import { runManualChat, runManualDiagnosis, runManualEvidenceQuery } from "./manual-execution.js";
import { resolveProviderModel } from "./provider-model.js";

export interface BridgeOptions {
  port?: number;
  /** Remote receiver URL to connect via WebSocket. Auto-detected from credentials if not specified. */
  receiverUrl?: string;
  /** Test-only: skip SIGINT/SIGTERM registration and allow controlled shutdown. */
  registerSignalHandlers?: boolean;
}

function sendJson(res: ServerResponse<IncomingMessage>, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(req: AsyncIterable<Buffer | string>): Promise<unknown> {
  const chunks: string[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
  }
  return chunks.length > 0 ? JSON.parse(chunks.join("")) : {};
}

function isRemoteUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    return hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1";
  } catch {
    return false;
  }
}

/**
 * Detect Vercel receiver URLs via hostname (fast path for *.vercel.app).
 * Custom-domain Vercel receivers are NOT detected here — use probeWsSupport()
 * for those, which actually attempts the WS connection and detects failure.
 */
function isVercelReceiverUrl(url: string): boolean {
  try {
    return new URL(url).hostname.includes("vercel.app");
  } catch {
    return false;
  }
}

/**
 * Probe whether a WebSocket endpoint is reachable and stays connected.
 * Returns true if the connection remains open for at least timeoutMs.
 * Returns false if the connection closes/errors within timeoutMs (e.g. Vercel
 * rejects WS upgrades with code 1006).
 *
 * The probe WebSocket is always closed before this function returns.
 *
 * Exported for testing.
 */
export function probeWsSupport(wsUrl: string, timeoutMs = 3_000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const settle = (result: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (ws) {
        try { ws.close(1000, "probe done"); } catch { /* ignore */ }
        ws = null;
      }
      resolve(result);
    };

    try {
      ws = new WebSocket(wsUrl);
    } catch {
      settle(false);
      return;
    }

    ws.addEventListener("open", () => {
      // Connection opened — wait for timeoutMs to confirm it stays up
      timer = setTimeout(() => settle(true), timeoutMs);
    });

    ws.addEventListener("close", () => {
      // Closed before timeout (or before open) — WS not supported
      settle(false);
    });

    ws.addEventListener("error", () => {
      // Error event always precedes close; settle false here too
      settle(false);
    });
  });
}

function httpToWs(url: string): string {
  return url.replace(/^http/, "ws");
}

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  } catch {
    return false;
  }
}

export function isAllowedBridgeOrigin(origin: string | undefined, receiverUrl?: string): boolean {
  if (!origin) return true;
  if (isLoopbackOrigin(origin)) return true;
  if (!receiverUrl) return false;

  try {
    return new URL(receiverUrl).origin === origin;
  } catch {
    return false;
  }
}

function applyCorsHeaders(
  res: ServerResponse<IncomingMessage>,
  origin: string | undefined,
): void {
  if (!origin) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Vary", "Origin");
}

// ── WebSocket bridge client ──────────────────────────────────────────────

interface WsMessage {
  type: string;
  id: string;
  [key: string]: unknown;
}

const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;

class WsBridgeClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;
  private shouldReconnect = true;
  private connected = false;

  constructor(
    private readonly wsUrl: string,
    private readonly onMessage: (msg: WsMessage) => void,
  ) {}

  connect(): void {
    if (this.ws) return;

    try {
      this.ws = new WebSocket(this.wsUrl);
    } catch (err) {
      process.stderr.write(
        `[bridge-ws] failed to create WebSocket: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      this.scheduleReconnect();
      return;
    }

    this.ws.addEventListener("open", () => {
      this.connected = true;
      this.backoffMs = INITIAL_BACKOFF_MS;
      process.stdout.write(`[bridge-ws] connected to ${this.wsUrl}\n`);
    });

    this.ws.addEventListener("message", (event: MessageEvent) => {
      try {
        const data = typeof event.data === "string" ? event.data : String(event.data);
        const msg = JSON.parse(data) as WsMessage;
        if (msg.type && msg.id) {
          this.onMessage(msg);
        }
      } catch {
        // ignore malformed messages
      }
    });

    this.ws.addEventListener("close", (event: CloseEvent) => {
      this.connected = false;
      this.ws = null;
      if (event.code !== 1000) {
        process.stderr.write(
          `[bridge-ws] connection closed (code=${event.code}, reason=${event.reason || "none"})\n`,
        );
      }
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    });

    this.ws.addEventListener("error", () => {
      // error event is always followed by close event
      this.connected = false;
    });
  }

  send(msg: unknown): void {
    if (this.ws && this.connected) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, "bridge shutting down");
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    process.stdout.write(`[bridge-ws] reconnecting in ${this.backoffMs}ms...\n`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }
}

// ── Message dispatch ─────────────────────────────────────────────────────

function resolveProvider(msgProvider: unknown, fallback: ProviderName | undefined): ProviderName | undefined {
  if (typeof msgProvider === "string" && msgProvider.length > 0) {
    return msgProvider as ProviderName;
  }
  return fallback;
}

async function handleWsMessage(
  msg: WsMessage,
  sendResponse: (response: unknown) => void,
  poolReady?: Promise<void>,
): Promise<void> {
  // Wait for the Claude Code pool to finish priming before dispatching LLM work.
  // Without this, the first real call queues behind the still-running prime in
  // the per-model serialized queue, and the combined time can exceed the 60s
  // receiver-side timeout.
  if (poolReady) {
    await poolReady;
  }

  const creds = loadCredentials();

  try {
    if (msg.type === "chat_request") {
      const provider = resolveProvider(msg["provider"], creds.llmProvider);
      const result = await runManualChat({
        receiverUrl: msg["receiverUrl"] as string,
        incidentId: msg["incidentId"] as string,
        authToken: msg["authToken"] as string | undefined,
        message: msg["message"] as string,
        history: (msg["history"] as Array<{ role: "user" | "assistant"; content: string }>) ?? [],
        provider,
        model: resolveProviderModel(provider, undefined, creds.llmModel),
        locale: creds.locale === "ja" ? "ja" : "en",
        systemPrompt: msg["systemPrompt"] as string | undefined,
      });
      sendResponse({ type: "chat_response", id: msg.id, reply: result.reply });
      return;
    }

    if (msg.type === "diagnose_request") {
      const provider = resolveProvider(msg["provider"], creds.llmProvider);
      const result = await runManualDiagnosis({
        receiverUrl: msg["receiverUrl"] as string,
        incidentId: msg["incidentId"] as string,
        authToken: msg["authToken"] as string | undefined,
        provider,
        model: resolveProviderModel(provider, undefined, creds.llmModel),
        locale: (msg["locale"] as "en" | "ja" | undefined) ?? (creds.locale === "ja" ? "ja" : "en"),
      });
      sendResponse({ type: "diagnose_response", id: msg.id, result });
      return;
    }

    if (msg.type === "evidence_query_request") {
      const provider = resolveProvider(msg["provider"], creds.llmProvider);
      const result = await runManualEvidenceQuery({
        receiverUrl: msg["receiverUrl"] as string,
        incidentId: msg["incidentId"] as string,
        authToken: msg["authToken"] as string | undefined,
        question: msg["question"] as string,
        history: (msg["history"] as Array<{ role: "user" | "assistant"; content: string }>) ?? [],
        provider,
        model: resolveProviderModel(provider, undefined, creds.llmModel),
        locale: (msg["locale"] as "en" | "ja") ?? (creds.locale === "ja" ? "ja" : "en"),
        diagnosisResult: msg["diagnosisResult"] as DiagnosisResult | undefined,
        evidence: msg["evidence"] as EvidenceResponse | undefined,
        isSystemFollowup: (msg["isSystemFollowup"] as boolean | undefined) ?? false,
        replyToClarification: msg["replyToClarification"] as { originalQuestion: string; clarificationText: string } | undefined,
      });
      sendResponse({ type: "evidence_query_response", id: msg.id, result });
      return;
    }

    sendResponse({ type: "error_response", id: msg.id, error: `unknown request type: ${msg.type}` });
  } catch (error) {
    sendResponse({
      type: "error_response",
      id: msg.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ── Main entry ───────────────────────────────────────────────────────────

export function runBridge(options: BridgeOptions = {}): { close: () => void } {
  const port = options.port ?? 4269;
  const registerSignalHandlers = options.registerSignalHandlers ?? true;

  // ── Warm up persistent Claude Code pool ───────────────────────────────
  // Store the promise so poll/WS handlers can await it before dispatching
  // LLM work. This prevents the first real call from queuing behind the
  // still-running prime and exceeding the 60s receiver-side timeout.
  const creds = loadCredentials();
  const receiverUrl = options.receiverUrl ?? creds.receiverUrl;
  let poolReadyPromise: Promise<void> = Promise.resolve();
  if (!creds.llmProvider || creds.llmProvider === "claude-code") {
    poolReadyPromise = primeClaudePool(creds.llmModel);
  }

  // ── HTTP server (always started, for local dev backward compat) ──────
  const server = createServer(async (req, res) => {
    const requestOrigin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (!isAllowedBridgeOrigin(requestOrigin, receiverUrl)) {
      sendJson(res, 403, { error: "origin not allowed" });
      return;
    }
    applyCorsHeaders(res, requestOrigin);
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (!req.url) {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    try {
      if (req.method === "GET" && req.url === "/healthz") {
        sendJson(res, 200, { status: "ok" });
        return;
      }

      if (req.method === "POST" && req.url === "/api/manual/diagnose") {
        const body = await readBody(req);
        const payload = body as {
          receiverUrl: string;
          incidentId: string;
          authToken?: string;
          provider?: ReturnType<typeof loadCredentials>["llmProvider"];
          model?: string;
        };
        const creds = loadCredentials();
        const provider = payload.provider ?? creds.llmProvider;
        const result = await runManualDiagnosis({
          receiverUrl: payload.receiverUrl,
          incidentId: payload.incidentId,
          authToken: payload.authToken,
          provider,
          model: resolveProviderModel(provider, payload.model, creds.llmModel),
          locale: creds.locale === "ja" ? "ja" : "en",
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && req.url === "/api/manual/chat") {
        const body = await readBody(req);
        const payload = body as {
          receiverUrl: string;
          incidentId: string;
          authToken?: string;
          message: string;
          history?: Array<{ role: "user" | "assistant"; content: string }>;
          provider?: ReturnType<typeof loadCredentials>["llmProvider"];
          model?: string;
          systemPrompt?: string;
        };
        const creds = loadCredentials();
        const provider = payload.provider ?? creds.llmProvider;
        const result = await runManualChat({
          receiverUrl: payload.receiverUrl,
          incidentId: payload.incidentId,
          authToken: payload.authToken,
          message: payload.message,
          history: payload.history ?? [],
          provider,
          model: resolveProviderModel(provider, payload.model, creds.llmModel),
          locale: creds.locale === "ja" ? "ja" : "en",
          systemPrompt: payload.systemPrompt,
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && req.url === "/api/manual/evidence-query") {
        const body = await readBody(req);
        const payload = body as {
          receiverUrl: string;
          incidentId: string;
          authToken?: string;
          question: string;
          history?: Array<{ role: "user" | "assistant"; content: string }>;
          provider?: ReturnType<typeof loadCredentials>["llmProvider"];
          model?: string;
          diagnosisResult?: DiagnosisResult;
          evidence?: EvidenceResponse;
          locale?: "en" | "ja";
          isSystemFollowup?: boolean;
          replyToClarification?: { originalQuestion: string; clarificationText: string };
        };
        const creds = loadCredentials();
        const provider = payload.provider ?? creds.llmProvider;
        const result = await runManualEvidenceQuery({
          receiverUrl: payload.receiverUrl,
          incidentId: payload.incidentId,
          authToken: payload.authToken,
          question: payload.question,
          history: payload.history ?? [],
          provider,
          model: resolveProviderModel(provider, payload.model, creds.llmModel),
          locale: payload.locale ?? (creds.locale === "ja" ? "ja" : "en"),
          diagnosisResult: payload.diagnosisResult,
          evidence: payload.evidence,
          isSystemFollowup: payload.isSystemFollowup ?? false,
          replyToClarification: payload.replyToClarification,
        });
        sendJson(res, 200, result);
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`3am bridge listening on http://127.0.0.1:${port}\n`);
  });

  // ── WebSocket client (for remote receivers) ─────────────────────────
  // Use URL-scoped credential lookup (matches diagnose.ts pattern)
  const matchedReceiver = receiverUrl
    ? findReceiverCredentialByUrl(creds, receiverUrl)
    : undefined;
  const authToken = matchedReceiver?.authToken ?? creds.receiverAuthToken;

  // ── Poll mode implementation (shared by Vercel and WS-fallback paths) ──

  function startPollMode(label: string): { close: () => void } {
    process.stdout.write(
      `[bridge-poll] starting long-poll bridge for ${label}: ${receiverUrl}\n`,
    );

    const POLL_INTERVAL_MS = 2_000;
    let pollStopped = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    async function pollOnce(): Promise<void> {
      if (pollStopped) return;
      try {
        const jobRes = await fetch(`${receiverUrl}/api/bridge/jobs`, {
          method: "GET",
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
        });
        if (!jobRes.ok) {
          if (jobRes.status !== 401 && jobRes.status !== 403) {
            process.stderr.write(
              `[bridge-poll] poll returned HTTP ${jobRes.status}\n`,
            );
          } else {
            process.stderr.write(
              `[bridge-poll] auth error (HTTP ${jobRes.status}) — check RECEIVER_AUTH_TOKEN\n`,
            );
          }
          return;
        }

        const payload = (await jobRes.json()) as {
          job: { jobId: string; request: WsMessage } | null;
        };

        if (!payload.job) return; // no pending jobs

        const { jobId, request } = payload.job;
        process.stdout.write(
          `[bridge-poll] picked up job ${jobId} (type=${request.type})\n`,
        );

        // Reuse the same dispatch logic as the WS bridge.
        // Pass poolReadyPromise so the handler waits for priming to finish
        // before dispatching LLM work — prevents cold-start timeout.
        await handleWsMessage(request, async (response) => {
          try {
            const resultRes = await fetch(
              `${receiverUrl}/api/bridge/results/${encodeURIComponent(jobId)}`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...(authToken
                    ? { Authorization: `Bearer ${authToken}` }
                    : {}),
                },
                body: JSON.stringify(response),
              },
            );
            if (!resultRes.ok) {
              process.stderr.write(
                `[bridge-poll] failed to post result for ${jobId}: HTTP ${resultRes.status}\n`,
              );
            }
          } catch (err) {
            process.stderr.write(
              `[bridge-poll] failed to post result for ${jobId}: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }, poolReadyPromise);
      } catch (err) {
        if (!pollStopped) {
          process.stderr.write(
            `[bridge-poll] poll error: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
    }

    function schedulePoll(): void {
      if (pollStopped) return;
      pollTimer = setTimeout(async () => {
        await pollOnce();
        schedulePoll();
      }, POLL_INTERVAL_MS);
    }

    // Start first poll immediately
    void pollOnce().then(() => schedulePoll());

    return {
      close: () => {
        pollStopped = true;
        if (pollTimer) {
          clearTimeout(pollTimer);
          pollTimer = null;
        }
      },
    };
  }

  if (receiverUrl && isRemoteUrl(receiverUrl) && !isVercelReceiverUrl(receiverUrl)) {
    // ── Non-Vercel remote receiver: try WS first, fall back to poll ───────
    // Custom-domain Vercel receivers will fail the WS probe (code 1006) and
    // automatically fall back to poll mode. Standard Node.js receivers will
    // stay connected and continue in WS mode.
    const wsUrl = `${httpToWs(receiverUrl)}/bridge/ws${authToken ? `?token=${encodeURIComponent(authToken)}` : ""}`;
    process.stdout.write(`[bridge-ws] connecting to remote receiver: ${receiverUrl}\n`);

    let activePollHandle: { close: () => void } | null = null;
    let wsClient: WsBridgeClient | null = null;

    // Probe WS support: if the connection closes within 3s, switch to poll mode
    void probeWsSupport(wsUrl).then((wsSupported) => {
      if (!wsSupported) {
        process.stdout.write(
          `[bridge-ws] WebSocket not supported (probe closed within 3s) — switching to poll mode\n`,
        );
        activePollHandle = startPollMode("custom-domain receiver");
        return;
      }

      // WS probe passed — create the real WsBridgeClient
      process.stdout.write(`[bridge-ws] WebSocket probe succeeded — using WS mode\n`);
      const client = new WsBridgeClient(wsUrl, (msg) => {
        void handleWsMessage(msg, (response) => client.send(response), poolReadyPromise);
      });
      wsClient = client;
      client.connect();
    });

    // Graceful shutdown
    const shutdown = () => {
      shutdownClaudePool();
      if (wsClient) wsClient.close();
      if (activePollHandle) activePollHandle.close();
      server.close();
    };
    if (registerSignalHandlers) {
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    }
    return { close: shutdown };
  } else if (receiverUrl && isVercelReceiverUrl(receiverUrl)) {
    // ── Vercel long-poll bridge (fast path for *.vercel.app) ─────────────
    // Vercel has no WS upgrade. Skip the WS probe and go directly to poll.
    const pollHandle = startPollMode("Vercel receiver");

    const shutdown = () => {
      pollHandle.close();
      shutdownClaudePool();
      server.close();
    };
    if (registerSignalHandlers) {
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    }
    return { close: shutdown };
  } else {
    // No WS client, no Vercel poll — still register shutdown for the claude pool
    const shutdown = () => {
      shutdownClaudePool();
      server.close();
    };
    if (registerSignalHandlers) {
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    }
    return { close: shutdown };
  }
}
