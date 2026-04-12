/**
 * Unit tests for WsBridgeManager (WebSocket bridge for remote manual mode #331).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WsBridgeManager, type BridgeWsConnection } from "../../transport/ws-bridge.js";

function createMockWs(): BridgeWsConnection & {
  sentMessages: string[];
  closeCalls: Array<{ code?: number; reason?: string }>;
} {
  const sent: string[] = [];
  const closeCalls: Array<{ code?: number; reason?: string }> = [];
  return {
    sentMessages: sent,
    closeCalls,
    send(data: string | ArrayBuffer) {
      sent.push(typeof data === "string" ? data : new TextDecoder().decode(data));
    },
    close(code?: number, reason?: string) {
      closeCalls.push({ code, reason });
    },
  };
}

describe("WsBridgeManager", () => {
  let bridge: WsBridgeManager;

  beforeEach(() => {
    bridge = new WsBridgeManager();
  });

  // ── Connection lifecycle ───────────────────────────────────────────

  it("starts with no connection", () => {
    expect(bridge.isConnected()).toBe(false);
  });

  it("reports connected after setConnection", () => {
    const ws = createMockWs();
    bridge.setConnection(ws);
    expect(bridge.isConnected()).toBe(true);
  });

  it("reports disconnected after removeConnection", () => {
    const ws = createMockWs();
    bridge.setConnection(ws);
    bridge.removeConnection(ws);
    expect(bridge.isConnected()).toBe(false);
  });

  it("does not remove if a different ws is passed", () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    bridge.setConnection(ws1);
    bridge.removeConnection(ws2);
    expect(bridge.isConnected()).toBe(true);
  });

  it("closes old connection when a new one is set", () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    bridge.setConnection(ws1);
    bridge.setConnection(ws2);
    expect(ws1.closeCalls.length).toBe(1);
    expect(ws1.closeCalls[0]?.code).toBe(1000);
    expect(bridge.isConnected()).toBe(true);
  });

  it("rejects pending requests when connection is replaced", async () => {
    const ws1 = createMockWs();
    bridge.setConnection(ws1);

    const promise = bridge.chat({
      incidentId: "inc_replace",
      receiverUrl: "https://example.com",
      message: "hi",
      history: [],
    });

    // Replace connection before responding
    const ws2 = createMockWs();
    bridge.setConnection(ws2);

    await expect(promise).rejects.toThrow("bridge connection replaced");
  });

  // ── Request-response correlation ────────────────────────────────────

  it("sends a chat request and resolves on matching response", async () => {
    const ws = createMockWs();
    bridge.setConnection(ws);

    const promise = bridge.chat({
      incidentId: "inc_1",
      receiverUrl: "https://example.com",
      message: "hello",
      history: [],
    });

    // Extract the request ID from the sent message
    expect(ws.sentMessages.length).toBe(1);
    const sentMsg = JSON.parse(ws.sentMessages[0]!) as { id: string; type: string };
    expect(sentMsg.type).toBe("chat_request");
    expect(sentMsg.id).toBeTruthy();

    // Simulate bridge response
    bridge.handleMessage(JSON.stringify({
      type: "chat_response",
      id: sentMsg.id,
      reply: "bridge says hi",
    }));

    const result = await promise;
    expect(result).toEqual({ reply: "bridge says hi" });
  });

  it("sends a diagnose request and resolves on matching response", async () => {
    const ws = createMockWs();
    bridge.setConnection(ws);

    const promise = bridge.diagnose({
      incidentId: "inc_2",
      receiverUrl: "https://example.com",
    });

    const sentMsg = JSON.parse(ws.sentMessages[0]!) as { id: string };

    bridge.handleMessage(JSON.stringify({
      type: "diagnose_response",
      id: sentMsg.id,
      result: { summary: "test" },
    }));

    const result = await promise;
    expect(result).toEqual({ result: { summary: "test" } });
  });

  it("sends an evidence query request and resolves on matching response", async () => {
    const ws = createMockWs();
    bridge.setConnection(ws);

    const promise = bridge.evidenceQuery({
      incidentId: "inc_3",
      receiverUrl: "https://example.com",
      question: "what happened?",
      history: [],
    });

    const sentMsg = JSON.parse(ws.sentMessages[0]!) as { id: string };

    bridge.handleMessage(JSON.stringify({
      type: "evidence_query_response",
      id: sentMsg.id,
      result: { question: "what happened?", status: "answered" },
    }));

    const result = await promise;
    expect(result).toEqual({ result: { question: "what happened?", status: "answered" } });
  });

  // ── Error handling ──────────────────────────────────────────────────

  it("rejects with error_response", async () => {
    const ws = createMockWs();
    bridge.setConnection(ws);

    const promise = bridge.chat({
      incidentId: "inc_err",
      receiverUrl: "https://example.com",
      message: "hi",
      history: [],
    });

    const sentMsg = JSON.parse(ws.sentMessages[0]!) as { id: string };

    bridge.handleMessage(JSON.stringify({
      type: "error_response",
      id: sentMsg.id,
      error: "something went wrong",
    }));

    await expect(promise).rejects.toThrow("something went wrong");
  });

  it("throws when no bridge is connected", async () => {
    await expect(
      bridge.chat({
        incidentId: "inc_no_ws",
        receiverUrl: "https://example.com",
        message: "hi",
        history: [],
      }),
    ).rejects.toThrow("no bridge connected");
  });

  it("rejects all pending requests when connection closes", async () => {
    const ws = createMockWs();
    bridge.setConnection(ws);

    const promise1 = bridge.chat({
      incidentId: "inc_a",
      receiverUrl: "https://example.com",
      message: "hi",
      history: [],
    });

    const promise2 = bridge.diagnose({
      incidentId: "inc_b",
      receiverUrl: "https://example.com",
    });

    // Simulate connection close
    bridge.removeConnection(ws);

    await expect(promise1).rejects.toThrow("bridge connection closed");
    await expect(promise2).rejects.toThrow("bridge connection closed");
  });

  it("ignores malformed messages", () => {
    const ws = createMockWs();
    bridge.setConnection(ws);

    // Should not throw
    bridge.handleMessage("not json");
    bridge.handleMessage(JSON.stringify({ type: "chat_response" })); // missing id
    bridge.handleMessage(JSON.stringify({ id: "unknown_id", type: "chat_response", reply: "hi" })); // no matching pending
  });

  it("ignores responses for unknown request IDs", async () => {
    const ws = createMockWs();
    bridge.setConnection(ws);

    // Should not throw
    bridge.handleMessage(JSON.stringify({
      type: "chat_response",
      id: "req_nonexistent",
      reply: "orphan",
    }));
  });

  // ── Timeout ─────────────────────────────────────────────────────────

  it("times out if no response arrives", async () => {
    vi.useFakeTimers();
    const ws = createMockWs();
    bridge.setConnection(ws);

    const promise = bridge.chat({
      incidentId: "inc_timeout",
      receiverUrl: "https://example.com",
      message: "hi",
      history: [],
    });

    // Advance past the 5-minute timeout
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    await expect(promise).rejects.toThrow("bridge request timed out");

    vi.useRealTimers();
  });

  // ── No WS + remote = not connected ──────────────────────────────

  it("isConnected returns false when bridge manager has no WS connection", () => {
    expect(bridge.isConnected()).toBe(false);
  });
});
