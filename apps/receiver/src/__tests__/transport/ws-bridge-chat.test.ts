/**
 * Integration test: chat endpoint routes through WebSocket bridge in manual mode (#331).
 *
 * Verifies:
 * - WS bridge connected + manual mode -> routes via WS (not HTTP)
 * - WS bridge NOT connected + manual mode -> falls back to HTTP proxy
 * - WS bridge connected but error -> returns 502
 * - Automatic mode ignores WS bridge entirely
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryAdapter } from "../../storage/adapters/memory.js";
import { createApp } from "../../index.js";
import { WsBridgeManager, type BridgeWsConnection } from "../../transport/ws-bridge.js";
import { COOKIE_NAME } from "../../middleware/session-cookie.js";
import type { DiagnosisResult } from "@3am/core";

const { mockCallModelMessages } = vi.hoisted(() => {
  const callModelMessages = vi.fn();
  return { mockCallModelMessages: callModelMessages };
});
vi.mock("@3am/diagnosis", async () => {
  const actual = await vi.importActual("@3am/diagnosis");
  return { ...actual, callModelMessages: mockCallModelMessages };
});

const TOKEN = "test-token";

function createMockWs(): BridgeWsConnection & { sentMessages: string[] } {
  const sent: string[] = [];
  return {
    sentMessages: sent,
    send(data: string | ArrayBuffer) {
      sent.push(typeof data === "string" ? data : new TextDecoder().decode(data));
    },
    close() {},
  };
}

function makeApp(wsBridge?: WsBridgeManager) {
  process.env["RECEIVER_AUTH_TOKEN"] = TOKEN;
  process.env["ANTHROPIC_API_KEY"] = "test-key";
  delete process.env["LLM_MODE"];
  delete process.env["LLM_PROVIDER"];
  delete process.env["LLM_BRIDGE_URL"];
  return createApp(new MemoryAdapter(), { wsBridge });
}

function authHeader() {
  return { Authorization: `Bearer ${TOKEN}` };
}

function extractSessionCookie(res: Response): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return match?.[1] ?? "";
}

async function getSessionCookie(app: ReturnType<typeof makeApp>): Promise<string> {
  const res = await app.request("/api/incidents", { headers: authHeader() });
  return extractSessionCookie(res);
}

function chatHeaders(sessionCookie: string) {
  return {
    "Content-Type": "application/json",
    Cookie: `${COOKIE_NAME}=${sessionCookie}`,
  };
}

const minimalDiagnosis: DiagnosisResult = {
  summary: {
    what_happened: "Rate limiter cascade caused 504s.",
    root_cause_hypothesis: "Stripe 429 leaked into checkout.",
  },
  recommendation: {
    immediate_action: "Disable Stripe retry loop.",
    action_rationale_short: "Stops cascading 429s.",
    do_not: "Do not increase timeout.",
  },
  reasoning: {
    causal_chain: [
      { type: "external", title: "Stripe 429", detail: "Rate limited." },
      { type: "impact", title: "Checkout 504", detail: "Timed out." },
    ],
  },
  operator_guidance: { watch_items: [], operator_checks: [] },
  confidence: {
    confidence_assessment: "High",
    uncertainty: "Unknown Stripe quota.",
  },
  metadata: {
    incident_id: "",
    packet_id: "pkt_test",
    model: "claude-haiku-4-5-20251001",
    prompt_version: "v5",
    created_at: new Date().toISOString(),
  },
};

let seedCounter = 0;

async function seedIncidentWithDiagnosis(app: ReturnType<typeof makeApp>) {
  seedCounter++;
  const suffix = String(seedCounter).padStart(3, "0");
  const ingestRes = await app.request("/v1/traces", {
    method: "POST",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({
      resourceSpans: [{
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: `svc-${suffix}` } },
            { key: "deployment.environment.name", value: { stringValue: "production" } },
          ],
        },
        scopeSpans: [{
          spans: [{
            traceId: `trace_${suffix}`,
            spanId: `span_${suffix}`,
            name: "POST /checkout",
            startTimeUnixNano: "1741392000000000000",
            endTimeUnixNano: "1741392005200000000",
            status: { code: 2 },
            attributes: [
              { key: "http.route", value: { stringValue: "/checkout" } },
              { key: "http.response.status_code", value: { intValue: 504 } },
            ],
          }],
        }],
      }],
    }),
  });
  const { incidentId } = (await ingestRes.json()) as { incidentId: string };
  const dr: DiagnosisResult = {
    ...minimalDiagnosis,
    metadata: { ...minimalDiagnosis.metadata, incident_id: incidentId },
  };
  await app.request(`/api/diagnosis/${incidentId}`, {
    method: "POST",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(dr),
  });
  return incidentId;
}

async function setManualMode(app: ReturnType<typeof makeApp>) {
  await app.request("/api/settings/diagnosis", {
    method: "PUT",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "manual", provider: "codex", bridgeUrl: "http://127.0.0.1:4269" }),
  });
}

describe("Chat endpoint with WebSocket bridge (#331)", () => {
  beforeEach(() => {
    seedCounter = 0;
    mockCallModelMessages.mockReset();
    mockCallModelMessages.mockResolvedValue("direct LLM reply");
  });

  it("routes through WS bridge when connected and manual mode", async () => {
    const wsBridge = new WsBridgeManager();
    const ws = createMockWs();
    wsBridge.setConnection(ws);

    const app = makeApp(wsBridge);
    await setManualMode(app);
    const cookie = await getSessionCookie(app);
    const incidentId = await seedIncidentWithDiagnosis(app);

    // Start the request (will send to WS)
    const chatPromise = app.request(`/api/chat/${incidentId}`, {
      method: "POST",
      headers: chatHeaders(cookie),
      body: JSON.stringify({ message: "What happened?", history: [] }),
    });

    // Wait a tick for the request to be sent to WS
    await new Promise((r) => setTimeout(r, 10));

    // Get the sent message and respond
    expect(ws.sentMessages.length).toBe(1);
    const req = JSON.parse(ws.sentMessages[0]!) as { id: string; type: string };
    expect(req.type).toBe("chat_request");

    wsBridge.handleMessage(JSON.stringify({
      type: "chat_response",
      id: req.id,
      reply: "WS bridge reply",
    }));

    const res = await chatPromise;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reply: "WS bridge reply" });
    expect(mockCallModelMessages).not.toHaveBeenCalled();
  });

  it("falls back to HTTP proxy when WS not connected but manual mode", async () => {
    const wsBridge = new WsBridgeManager();
    // No WS connection set
    const app = makeApp(wsBridge);
    await setManualMode(app);

    const originalFetch = globalThis.fetch;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ reply: "HTTP bridge reply" }),
    });
    globalThis.fetch = mockFetch as typeof fetch;

    const cookie = await getSessionCookie(app);
    const incidentId = await seedIncidentWithDiagnosis(app);
    const res = await app.request(`/api/chat/${incidentId}`, {
      method: "POST",
      headers: chatHeaders(cookie),
      body: JSON.stringify({ message: "What happened?", history: [] }),
    });

    globalThis.fetch = originalFetch;

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reply: "HTTP bridge reply" });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4269/api/manual/chat",
      expect.objectContaining({ method: "POST" }),
    );
    expect(mockCallModelMessages).not.toHaveBeenCalled();
  });

  it("returns 502 when WS bridge is connected but returns error", async () => {
    const wsBridge = new WsBridgeManager();
    const ws = createMockWs();
    wsBridge.setConnection(ws);

    const app = makeApp(wsBridge);
    await setManualMode(app);
    const cookie = await getSessionCookie(app);
    const incidentId = await seedIncidentWithDiagnosis(app);

    const chatPromise = app.request(`/api/chat/${incidentId}`, {
      method: "POST",
      headers: chatHeaders(cookie),
      body: JSON.stringify({ message: "What happened?", history: [] }),
    });

    await new Promise((r) => setTimeout(r, 10));
    const req = JSON.parse(ws.sentMessages[0]!) as { id: string };
    wsBridge.handleMessage(JSON.stringify({
      type: "error_response",
      id: req.id,
      error: "LLM provider unavailable",
    }));

    const res = await chatPromise;
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; details: string };
    expect(body.error).toBe("manual chat bridge failed");
    expect(body.details).toContain("LLM provider unavailable");
  });

  it("uses direct LLM in automatic mode, ignoring WS bridge", async () => {
    const wsBridge = new WsBridgeManager();
    const ws = createMockWs();
    wsBridge.setConnection(ws);

    // Default mode is automatic — no need to set manual
    const app = makeApp(wsBridge);
    const cookie = await getSessionCookie(app);
    const incidentId = await seedIncidentWithDiagnosis(app);

    const res = await app.request(`/api/chat/${incidentId}`, {
      method: "POST",
      headers: chatHeaders(cookie),
      body: JSON.stringify({ message: "What happened?", history: [] }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reply: "direct LLM reply" });
    expect(mockCallModelMessages).toHaveBeenCalledOnce();
    // WS bridge should NOT have received any messages
    expect(ws.sentMessages.length).toBe(0);
  });

  // ── Bridge status endpoint ──────────────────────────────────────────

  it("bridge status reports connected when WS is active", async () => {
    const wsBridge = new WsBridgeManager();
    const ws = createMockWs();
    wsBridge.setConnection(ws);

    const app = makeApp(wsBridge);
    const res = await app.request("/api/bridge/status", { headers: authHeader() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true });
  });

  it("bridge status reports disconnected when no WS", async () => {
    const app = makeApp();
    const res = await app.request("/api/bridge/status", { headers: authHeader() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
  });

  it("bridge status requires auth", async () => {
    const app = makeApp();
    const res = await app.request("/api/bridge/status");
    expect(res.status).toBe(401);
  });
});
