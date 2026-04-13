/**
 * WebSocket bridge for remote manual mode.
 *
 * When the 3am receiver is deployed to a remote platform (e.g. CF Workers),
 * the bridge (CLI) cannot be reached at localhost. Instead, the bridge
 * initiates an outbound WebSocket connection to the receiver's /bridge/ws
 * endpoint. The receiver pushes chat/diagnose/evidence-query requests
 * through that WebSocket and the bridge responds through it.
 *
 * Platform support:
 * - CF Workers: WebSocket upgrade handled natively via WebSocketPair in cf-entry.ts
 * - Node.js (local dev): WebSocket upgrade handled in server.ts. HTTP proxy also works on localhost.
 *
 * Vercel's deployed receiver entrypoint is HTTP-only in this repo, so /bridge/ws
 * is not available there. Remote Vercel deployments must use a public HTTP bridge
 * URL or a different relay runtime.
 *
 * Message protocol (JSON over WebSocket):
 *
 * receiver -> bridge:
 *   { type: "chat_request",     id, incidentId, receiverUrl, authToken?, message, history, provider? }
 *   { type: "diagnose_request", id, incidentId, receiverUrl, authToken?, provider?, locale? }
 *   { type: "evidence_query_request", id, incidentId, receiverUrl, authToken?, question, history, provider? }
 *
 * bridge -> receiver:
 *   { type: "chat_response",     id, reply }
 *   { type: "diagnose_response", id, result }
 *   { type: "evidence_query_response", id, result }
 *   { type: "error_response",    id, error }
 */

/** Minimal interface for a WebSocket connection — compatible with hono/ws BridgeWsConnection and native WS wrappers. */
export interface BridgeWsConnection {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

export interface ChatRequest {
  type: "chat_request";
  id: string;
  incidentId: string;
  receiverUrl: string;
  authToken?: string;
  message: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  provider?: string;
  systemPrompt?: string;
}

export interface DiagnoseRequest {
  type: "diagnose_request";
  id: string;
  incidentId: string;
  receiverUrl: string;
  authToken?: string;
  provider?: string;
  locale?: string;
}

export interface EvidenceQueryRequest {
  type: "evidence_query_request";
  id: string;
  incidentId: string;
  receiverUrl: string;
  authToken?: string;
  question: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  provider?: string;
  diagnosisResult?: unknown;
  evidence?: unknown;
  locale?: string;
  isSystemFollowup?: boolean;
}

export type BridgeRequest = ChatRequest | DiagnoseRequest | EvidenceQueryRequest;

export interface ChatResponse {
  type: "chat_response";
  id: string;
  reply: string;
}

export interface DiagnoseResponse {
  type: "diagnose_response";
  id: string;
  result: unknown;
}

export interface EvidenceQueryResponse {
  type: "evidence_query_response";
  id: string;
  result: unknown;
}

export interface ErrorResponse {
  type: "error_response";
  id: string;
  error: string;
}

export type BridgeResponse = ChatResponse | DiagnoseResponse | EvidenceQueryResponse | ErrorResponse;

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface PendingRequest {
  resolve: (response: BridgeResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Manages the WebSocket bridge connection and request-response correlation.
 * Singleton per receiver instance.
 */
export class WsBridgeManager {
  private connection: BridgeWsConnection | null = null;
  private pending = new Map<string, PendingRequest>();
  private idCounter = 0;

  /** Register an active WebSocket connection from a bridge client. */
  setConnection(ws: BridgeWsConnection): void {
    // Close any existing connection and reject its pending requests
    if (this.connection) {
      try {
        this.connection.close(1000, "replaced by new connection");
      } catch {
        // ignore close errors on stale connections
      }
      // Reject all pending requests tied to the old connection
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("bridge connection replaced"));
        this.pending.delete(id);
      }
    }
    this.connection = ws;
  }

  /** Remove the active connection (on close/error). */
  removeConnection(ws: BridgeWsConnection): void {
    if (this.connection === ws) {
      this.connection = null;
      // Reject all pending requests
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("bridge connection closed"));
        this.pending.delete(id);
      }
    }
  }

  /** Check whether a bridge is connected. */
  isConnected(): boolean {
    return this.connection !== null;
  }

  /** Handle an incoming message from the bridge. */
  handleMessage(data: string | ArrayBuffer): void {
    let msg: BridgeResponse;
    try {
      const text = typeof data === "string" ? data : new TextDecoder().decode(data);
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

  /** Send a request to the bridge and wait for the correlated response. */
  async sendRequest(request: BridgeRequest): Promise<BridgeResponse> {
    if (!this.connection) {
      throw new Error("no bridge connected");
    }

    const id = `req_${++this.idCounter}_${Date.now()}`;
    const requestWithId = { ...request, id };

    return new Promise<BridgeResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("bridge request timed out"));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });

      try {
        this.connection!.send(JSON.stringify(requestWithId));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`failed to send to bridge: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  }

  /** Generate a unique request ID. */
  nextId(): string {
    return `req_${++this.idCounter}_${Date.now()}`;
  }

  /** Send a chat request and return the reply string. */
  async chat(opts: {
    incidentId: string;
    receiverUrl: string;
    authToken?: string;
    message: string;
    history: Array<{ role: "user" | "assistant"; content: string }>;
    provider?: string;
    systemPrompt?: string;
  }): Promise<{ reply: string }> {
    const response = await this.sendRequest({
      type: "chat_request",
      id: "", // will be overwritten by sendRequest
      ...opts,
    });

    if (response.type === "error_response") {
      throw new Error(response.error);
    }
    if (response.type !== "chat_response") {
      throw new Error(`unexpected response type: ${response.type}`);
    }
    return { reply: response.reply };
  }

  /** Send a diagnose request and return the result. */
  async diagnose(opts: {
    incidentId: string;
    receiverUrl: string;
    authToken?: string;
    provider?: string;
    locale?: string;
  }): Promise<{ result: unknown }> {
    const response = await this.sendRequest({
      type: "diagnose_request",
      id: "",
      ...opts,
    });

    if (response.type === "error_response") {
      throw new Error(response.error);
    }
    if (response.type !== "diagnose_response") {
      throw new Error(`unexpected response type: ${response.type}`);
    }
    return { result: response.result };
  }

  /** Send an evidence query request and return the result. */
  async evidenceQuery(opts: {
    incidentId: string;
    receiverUrl: string;
    authToken?: string;
    question: string;
    history: Array<{ role: "user" | "assistant"; content: string }>;
    provider?: string;
    diagnosisResult?: unknown;
    evidence?: unknown;
    locale?: string;
    isSystemFollowup?: boolean;
  }): Promise<{ result: unknown }> {
    const response = await this.sendRequest({
      type: "evidence_query_request",
      id: "",
      ...opts,
    });

    if (response.type === "error_response") {
      throw new Error(response.error);
    }
    if (response.type !== "evidence_query_response") {
      throw new Error(`unexpected response type: ${response.type}`);
    }
    return { result: response.result };
  }
}
