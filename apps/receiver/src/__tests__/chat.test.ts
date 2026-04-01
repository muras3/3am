/**
 * Unit tests for POST /api/chat/:incidentId
 *
 * Diagnosis model calls are mocked so no real provider or API key is required.
 * Each test exercises one contract condition from ADR 0027.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryAdapter } from "../storage/adapters/memory.js";
import { createApp } from "../index.js";
import { COOKIE_NAME } from "../middleware/session-cookie.js";
import type { DiagnosisResult } from "@3amoncall/core";

// ── Mock diagnosis model layer ─────────────────────────────────────────────
const { mockCallModelMessages } = vi.hoisted(() => {
  const callModelMessages = vi.fn();
  return { mockCallModelMessages: callModelMessages };
});
vi.mock("@3amoncall/diagnosis", async () => {
  const actual = await vi.importActual<typeof import("@3amoncall/diagnosis")>("@3amoncall/diagnosis");
  return {
    ...actual,
    callModelMessages: mockCallModelMessages,
  };
});

// ── Helpers ────────────────────────────────────────────────────────────────
const TOKEN = "test-token";

function makeApp() {
  process.env["RECEIVER_AUTH_TOKEN"] = TOKEN;
  process.env["ANTHROPIC_API_KEY"] = "test-key";
  return createApp(new MemoryAdapter());
}

function authHeader() {
  return { Authorization: `Bearer ${TOKEN}` };
}

/** Extract the session cookie value from a Set-Cookie response header. */
function extractSessionCookie(res: Response): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return match?.[1] ?? "";
}

/** Get a valid session cookie by hitting an /api/* endpoint (Bearer required). */
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
    what_happened: "Rate limiter cascade caused 504s on /checkout.",
    root_cause_hypothesis: "Stripe 429 leaked into checkout timeout budget.",
  },
  recommendation: {
    immediate_action: "Disable Stripe retry loop. Add circuit breaker.",
    action_rationale_short: "Stops cascading 429s from consuming server threads.",
    do_not: "Do not increase timeout — it worsens head-of-line blocking.",
  },
  reasoning: {
    causal_chain: [
      { type: "external", title: "Stripe 429", detail: "Stripe rate limited." },
      { type: "system", title: "Thread exhaustion", detail: "Workers blocked on retries." },
      { type: "incident", title: "Checkout 504", detail: "Gateway timed out." },
      { type: "impact", title: "Revenue loss", detail: "Checkout unavailable." },
    ],
  },
  operator_guidance: {
    watch_items: [],
    operator_checks: ["Confirm Stripe dashboard shows 429 spike."],
  },
  confidence: {
    confidence_assessment: "High",
    uncertainty: "Unknown Stripe quota reset time.",
  },
  metadata: {
    incident_id: "inc_test_001",
    packet_id: "pkt_test_001",
    model: "claude-haiku-4-5-20251001",
    prompt_version: "v5",
    created_at: new Date().toISOString(),
  },
};

let seedCounter = 0;
async function seedIncidentWithDiagnosis(app: ReturnType<typeof makeApp>) {
  seedCounter++;
  const suffix = String(seedCounter).padStart(3, "0");
  // Ingest an anomalous span to create an incident — unique service per call for incident isolation
  const ingestRes = await app.request("/v1/traces", {
    method: "POST",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: `web-${suffix}` } },
              { key: "deployment.environment.name", value: { stringValue: "production" } },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: `abc123_${suffix}`,
                  spanId: `span${suffix}`,
                  name: "POST /checkout",
                  startTimeUnixNano: "1741392000000000000",
                  endTimeUnixNano: "1741392005200000000",
                  status: { code: 2 },
                  attributes: [
                    { key: "http.route", value: { stringValue: "/checkout" } },
                    { key: "http.response.status_code", value: { intValue: 504 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
  });
  const { incidentId } = (await ingestRes.json()) as { incidentId: string };

  // Attach a diagnosis result
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

// ── Tests ──────────────────────────────────────────────────────────────────
describe("POST /api/chat/:incidentId", () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    seedCounter = 0;
    app = makeApp();
    mockCallModelMessages.mockReset();
    mockCallModelMessages.mockResolvedValue("This is the assistant reply.");
  });

  // ── Session cookie auth (B-11) ────────────────────────────────────────────

  it("returns 401 without session cookie (B-11)", async () => {
    const res = await app.request("/api/chat/inc_unknown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hello", history: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 with invalid session cookie (B-11)", async () => {
    const res = await app.request("/api/chat/inc_unknown", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `${COOKIE_NAME}=invalid-token` },
      body: JSON.stringify({ message: "Hello", history: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("session cookie is set on /api/* responses as JWT (B-11)", async () => {
    const res = await app.request("/api/incidents", { headers: authHeader() });
    const cookie = extractSessionCookie(res);
    expect(cookie).toBeTruthy();
    // JWT format: three base64url segments separated by dots
    expect(cookie.split(".")).toHaveLength(3);
  });

  it("returns 404 for unknown incidentId", async () => {
    const cookie = await getSessionCookie(app);
    const res = await app.request("/api/chat/inc_unknown", {
      method: "POST",
      headers: chatHeaders(cookie),
      body: JSON.stringify({ message: "Hello", history: [] }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when diagnosis is not yet available", async () => {
    const cookie = await getSessionCookie(app);
    // Create incident without attaching diagnosis
    const ingestRes = await app.request("/v1/traces", {
      method: "POST",
      headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({
        resourceSpans: [
          {
            resource: {
              attributes: [
                { key: "service.name", value: { stringValue: "svc" } },
                { key: "deployment.environment.name", value: { stringValue: "production" } },
              ],
            },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "def456",
                    spanId: "span002",
                    name: "GET /api",
                    startTimeUnixNano: "1741392100000000000",
                    endTimeUnixNano: "1741392106000000000",
                    status: { code: 2 },
                    attributes: [
                      { key: "http.route", value: { stringValue: "/api" } },
                      { key: "http.response.status_code", value: { intValue: 500 } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    });
    const { incidentId } = (await ingestRes.json()) as { incidentId: string };

    const res = await app.request(`/api/chat/${incidentId}`, {
      method: "POST",
      headers: chatHeaders(cookie),
      body: JSON.stringify({ message: "What happened?", history: [] }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when message is missing", async () => {
    const cookie = await getSessionCookie(app);
    const incidentId = await seedIncidentWithDiagnosis(app);
    const res = await app.request(`/api/chat/${incidentId}`, {
      method: "POST",
      headers: chatHeaders(cookie),
      body: JSON.stringify({ history: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when message exceeds 500 chars", async () => {
    const cookie = await getSessionCookie(app);
    const incidentId = await seedIncidentWithDiagnosis(app);
    const res = await app.request(`/api/chat/${incidentId}`, {
      method: "POST",
      headers: chatHeaders(cookie),
      body: JSON.stringify({ message: "x".repeat(501), history: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 422 when history exceeds 10 turns", async () => {
    const cookie = await getSessionCookie(app);
    const incidentId = await seedIncidentWithDiagnosis(app);
    const history = Array.from({ length: 11 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn ${i}`,
    }));
    const res = await app.request(`/api/chat/${incidentId}`, {
      method: "POST",
      headers: chatHeaders(cookie),
      body: JSON.stringify({ message: "One more question", history }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 200 with reply on valid request", async () => {
    const cookie = await getSessionCookie(app);
    const incidentId = await seedIncidentWithDiagnosis(app);
    const res = await app.request(`/api/chat/${incidentId}`, {
      method: "POST",
      headers: chatHeaders(cookie),
      body: JSON.stringify({ message: "What should I do first?", history: [] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reply: string };
    expect(body.reply).toBe("This is the assistant reply.");
    expect(mockCallModelMessages).toHaveBeenCalledOnce();
  });

  it("passes chat model settings through the provider layer", async () => {
    const cookie = await getSessionCookie(app);
    const incidentId = await seedIncidentWithDiagnosis(app);

    await app.request(`/api/chat/${incidentId}`, {
      method: "POST",
      headers: chatHeaders(cookie),
      body: JSON.stringify({ message: "What should I do first?", history: [] }),
    });

    expect(mockCallModelMessages).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        model: "claude-haiku-4-5-20251001",
        maxTokens: 512,
        temperature: 0.3,
      }),
    );
  });

  it("passes conversation history to the model", async () => {
    const cookie = await getSessionCookie(app);
    const incidentId = await seedIncidentWithDiagnosis(app);
    const history = [
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
    ];
    await app.request(`/api/chat/${incidentId}`, {
      method: "POST",
      headers: chatHeaders(cookie),
      body: JSON.stringify({ message: "Follow up", history }),
    });

    const callArgs = mockCallModelMessages.mock.calls[0]?.[0] as Array<{ role: string }>;
    // history (2) + sandboxed new message (1) = 3
    expect(callArgs).toHaveLength(4);
    expect(callArgs[1]?.role).toBe("user");
    expect(callArgs[2]?.role).toBe("assistant");
    expect(callArgs[3]?.role).toBe("user");
  });

  // ── Locale-aware system prompt ────────────────────────────────────────────

  it("passes Japanese instruction in system prompt when locale is 'ja'", async () => {
    // Set locale to "ja" via the settings API
    await app.request("/api/settings/locale", {
      method: "PUT",
      headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ locale: "ja" }),
    });

    const cookie = await getSessionCookie(app);
    const incidentId = await seedIncidentWithDiagnosis(app);
    await app.request(`/api/chat/${incidentId}`, {
      method: "POST",
      headers: chatHeaders(cookie),
      body: JSON.stringify({ message: "What happened?", history: [] }),
    });

    const callArgs = mockCallModelMessages.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(callArgs[0]?.content).toContain("Respond in Japanese");
  });

  it("includes bounded inference guidance in the system prompt", async () => {
    const cookie = await getSessionCookie(app);
    const incidentId = await seedIncidentWithDiagnosis(app);

    await app.request(`/api/chat/${incidentId}`, {
      method: "POST",
      headers: chatHeaders(cookie),
      body: JSON.stringify({ message: "How do we stop this from happening again?", history: [] }),
    });

    const callArgs = mockCallModelMessages.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(callArgs[0]?.content).toContain("You may make limited, reasonable inferences");
    expect(callArgs[0]?.content).toContain("explicitly label it as a hypothesis or inference");
    expect(callArgs[0]?.content).toContain("If the question needs evidence beyond the diagnosis, say what should be checked next.");
  });

  it("includes confidence and uncertainty in the system prompt", async () => {
    const cookie = await getSessionCookie(app);
    const incidentId = await seedIncidentWithDiagnosis(app);

    await app.request(`/api/chat/${incidentId}`, {
      method: "POST",
      headers: chatHeaders(cookie),
      body: JSON.stringify({ message: "How certain are we?", history: [] }),
    });

    const callArgs = mockCallModelMessages.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(callArgs[0]?.content).toContain("Confidence: High");
    expect(callArgs[0]?.content).toContain("Known uncertainty: Unknown Stripe quota reset time.");
  });

  it("does not include Japanese instruction when locale is default 'en'", async () => {
    const cookie = await getSessionCookie(app);
    const incidentId = await seedIncidentWithDiagnosis(app);
    await app.request(`/api/chat/${incidentId}`, {
      method: "POST",
      headers: chatHeaders(cookie),
      body: JSON.stringify({ message: "What happened?", history: [] }),
    });

    const callArgs = mockCallModelMessages.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(callArgs[0]?.content).not.toContain("Respond in Japanese");
  });

  // ── Rate limiting (B-11) ──────────────────────────────────────────────────

  it("returns 429 when rate limit is exceeded (B-11)", async () => {
    const cookie = await getSessionCookie(app);
    const incidentId = await seedIncidentWithDiagnosis(app);

    // Send 10 requests (within limit)
    for (let i = 0; i < 10; i++) {
      const res = await app.request(`/api/chat/${incidentId}`, {
        method: "POST",
        headers: chatHeaders(cookie),
        body: JSON.stringify({ message: "question", history: [] }),
      });
      expect(res.status).toBe(200);
    }

    // 11th request should be rate limited
    const res = await app.request(`/api/chat/${incidentId}`, {
      method: "POST",
      headers: chatHeaders(cookie),
      body: JSON.stringify({ message: "question", history: [] }),
    });
    expect(res.status).toBe(429);
  });

  it("rate limit is independent per incident ID (B-11)", async () => {
    const cookie = await getSessionCookie(app);
    const incidentId1 = await seedIncidentWithDiagnosis(app);

    // Exhaust rate limit on incidentId1
    for (let i = 0; i < 10; i++) {
      await app.request(`/api/chat/${incidentId1}`, {
        method: "POST",
        headers: chatHeaders(cookie),
        body: JSON.stringify({ message: "q", history: [] }),
      });
    }

    // Different incident should still be allowed (same IP, different ID)
    const incidentId2 = await seedIncidentWithDiagnosis(app);
    const res = await app.request(`/api/chat/${incidentId2}`, {
      method: "POST",
      headers: chatHeaders(cookie),
      body: JSON.stringify({ message: "q", history: [] }),
    });
    expect(res.status).toBe(200);
  });

});
