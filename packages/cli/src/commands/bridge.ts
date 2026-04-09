import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ProviderName } from "@3am/diagnosis";
import { loadCredentials, findReceiverCredentialByUrl } from "./init/credentials.js";
import { runManualChat, runManualDiagnosis, runManualEvidenceQuery } from "./manual-execution.js";
import { resolveProviderModel } from "./provider-model.js";

export interface BridgeOptions {
  port?: number;
  /** Remote receiver URL to connect via WebSocket. Auto-detected from credentials if not specified. */
  receiverUrl?: string;
}

function sendJson(res: ServerResponse<IncomingMessage>, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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

function httpToWs(url: string): string {
  return url.replace(/^http/, "ws");
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

async function handleWsMessage(msg: WsMessage, sendResponse: (response: unknown) => void): Promise<void> {
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
        locale: creds.locale === "ja" ? "ja" : "en",
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

export function runBridge(options: BridgeOptions = {}): void {
  const port = options.port ?? 4269;

  // ── HTTP server (always started, for local dev backward compat) ──────
  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
          locale: creds.locale === "ja" ? "ja" : "en",
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
  const creds = loadCredentials();
  const receiverUrl = options.receiverUrl ?? creds.receiverUrl;
  // Use URL-scoped credential lookup (matches diagnose.ts pattern)
  const matchedReceiver = receiverUrl
    ? findReceiverCredentialByUrl(creds, receiverUrl)
    : undefined;
  const authToken = matchedReceiver?.authToken ?? creds.receiverAuthToken;

  if (receiverUrl && isRemoteUrl(receiverUrl)) {
    const wsUrl = `${httpToWs(receiverUrl)}/bridge/ws${authToken ? `?token=${encodeURIComponent(authToken)}` : ""}`;
    process.stdout.write(`[bridge-ws] connecting to remote receiver: ${receiverUrl}\n`);

    const wsClient = new WsBridgeClient(wsUrl, (msg) => {
      // Handle incoming request from receiver
      void handleWsMessage(msg, (response) => wsClient.send(response));
    });
    wsClient.connect();

    // Graceful shutdown
    const shutdown = () => {
      wsClient.close();
      server.close();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }
}
