/**
 * Durable Object WebSocket bridge for CF Workers.
 *
 * CF Workers isolates don't share in-memory state, so the in-memory
 * WsBridgeManager can't hold a WebSocket connection across requests.
 * This Durable Object acts as the single coordination point: both the
 * WS upgrade and API requests route to the same DO instance ("singleton"),
 * which holds the live WebSocket connection.
 *
 * Routes handled by this DO's fetch():
 *   GET  /bridge/ws    — WebSocket upgrade from bridge CLI
 *   POST /request      — API request (chat, diagnose, evidence-query) forwarded from cf-entry
 *   GET  /status       — Connection status check
 *
 * Uses the WebSocket Hibernation API (ctx.acceptWebSocket, webSocketMessage,
 * webSocketClose, webSocketError) so the DO can be evicted from memory between
 * messages and re-instantiated when a message arrives.
 *
 * Note: Types are defined locally to avoid @cloudflare/workers-types polluting
 * globals, consistent with cf-entry.ts pattern.
 */
import type {
  BridgeRequest,
  BridgeResponse,
} from "./ws-bridge.js";

// ── Local CF Durable Object types ──────────────────────────────────────────
// Avoids importing from "cloudflare:workers" which doesn't resolve in the
// standard tsc build. At runtime on CF Workers, these are satisfied by the
// platform globals.

interface DurableObjectState {
  /** Accept a WebSocket using the Hibernation API. */
  acceptWebSocket(ws: WebSocket): void;
  /** Get all WebSocket connections accepted by this DO. */
  getWebSockets(): WebSocket[];
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
  };
}

interface BridgeDOEnv {
  RECEIVER_AUTH_TOKEN?: string;
  ALLOW_INSECURE_DEV_MODE?: string;
}

// CF Workers WebSocketPair (global at runtime)
declare class WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}

// ── Constants ──────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface PendingRequest {
  resolve: (response: BridgeResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * BridgeDO — Durable Object that owns the WebSocket bridge connection.
 *
 * CF Workers requires DO classes to:
 * 1. Have a constructor(ctx, env)
 * 2. Have a fetch() method
 * 3. Optionally implement webSocketMessage/webSocketClose/webSocketError
 *    for the Hibernation API
 * 4. Be exported from the entry point module (cf-entry.ts re-exports this)
 */
export class BridgeDO {
  private ctx: DurableObjectState;
  private env: BridgeDOEnv;
  private pending = new Map<string, PendingRequest>();
  private idCounter = 0;

  constructor(ctx: DurableObjectState, env: BridgeDOEnv) {
    this.ctx = ctx;
    this.env = env;
  }

  /**
   * Handle incoming HTTP requests routed to this DO.
   *
   * - WebSocket upgrade for /bridge/ws
   * - POST /request for API requests (chat, diagnose, evidence-query)
   * - GET /status for connection status
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // ── WebSocket upgrade (/bridge/ws) ──────────────────────────────────
    if (url.pathname === "/bridge/ws" && request.headers.get("Upgrade") === "websocket") {
      // Auth: validate token from query param.
      // The resolved auth token is passed from cf-entry.ts via header
      // (covers both env var and DB-backed tokens).
      const queryToken = url.searchParams.get("token");
      const authToken = request.headers.get("X-Bridge-Auth-Token") || this.env.RECEIVER_AUTH_TOKEN;
      const allowInsecure = this.env.ALLOW_INSECURE_DEV_MODE === "true";

      if (!allowInsecure && authToken && queryToken !== authToken) {
        return new Response("unauthorized", { status: 401 });
      }

      // Close any existing bridge connections (only one bridge allowed)
      const existingWs = this.ctx.getWebSockets();
      for (const ws of existingWs) {
        try {
          ws.close(1000, "replaced by new connection");
        } catch {
          // ignore close errors on stale connections
        }
      }
      // Reject all pending requests tied to old connections
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("bridge connection replaced"));
        this.pending.delete(id);
      }

      // Create WebSocket pair and accept with Hibernation API
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server);

      // CF Workers requires the webSocket property on the Response.
      // Cast through unknown to satisfy TypeScript — at runtime on CF Workers
      // the Response constructor accepts { webSocket } in the init object.
      return new Response(null, {
        status: 101,
        webSocket: client,
      } as unknown as ResponseInit);
    }

    // ── API request forwarding (POST /request) ──────────────────────────
    if (url.pathname === "/request" && request.method === "POST") {
      const sockets = this.ctx.getWebSockets();
      if (sockets.length === 0) {
        return Response.json({ error: "no bridge connected" }, { status: 502 });
      }

      let body: BridgeRequest;
      try {
        body = await request.json() as BridgeRequest;
      } catch {
        return Response.json({ error: "invalid request body" }, { status: 400 });
      }

      const id = `req_${++this.idCounter}_${Date.now()}`;
      const requestWithId = { ...body, id };

      try {
        const response = await new Promise<BridgeResponse>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(id);
            reject(new Error("bridge request timed out"));
          }, REQUEST_TIMEOUT_MS);

          this.pending.set(id, { resolve, reject, timer });

          // Send to the newest connected WebSocket (last in the list)
          const ws = sockets[sockets.length - 1]!;
          try {
            ws.send(JSON.stringify(requestWithId));
          } catch (err) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(new Error(`failed to send to bridge: ${err instanceof Error ? err.message : String(err)}`));
          }
        });

        return Response.json(response);
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 502 },
        );
      }
    }

    // ── Connection status (GET /status) ─────────────────────────────────
    if (url.pathname === "/status") {
      const connected = this.ctx.getWebSockets().length > 0;
      return Response.json({ connected });
    }

    return new Response("not found", { status: 404 });
  }

  /**
   * WebSocket Hibernation API handler.
   * Called when a message is received from the bridge WebSocket.
   * Correlates the response to a pending request by ID.
   */
  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let msg: BridgeResponse;
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      msg = JSON.parse(text) as BridgeResponse;
    } catch {
      return; // ignore malformed messages
    }

    if (!msg.id || !msg.type) return;

    const pending = this.pending.get(msg.id);
    if (!pending) return; // no matching request

    clearTimeout(pending.timer);
    this.pending.delete(msg.id);
    pending.resolve(msg);
  }

  /**
   * WebSocket Hibernation API handler.
   * Called when the bridge WebSocket is closed.
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    try { ws.close(code, reason); } catch { /* already closed */ }

    // Only reject pending requests if this was the active connection.
    // Stale sockets from a replaced connection should not affect the new one.
    const activeSockets = this.ctx.getWebSockets();
    if (activeSockets.length === 0) {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("bridge connection closed"));
        this.pending.delete(id);
      }
    }
  }

  /**
   * WebSocket Hibernation API handler.
   * Called when a WebSocket error occurs.
   */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("[BridgeDO] WebSocket error:", error);
    try { ws.close(1011, "internal error"); } catch { /* already closed */ }

    const activeSockets = this.ctx.getWebSockets();
    if (activeSockets.length === 0) {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("bridge WebSocket error"));
        this.pending.delete(id);
      }
    }
  }
}
