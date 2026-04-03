/**
 * Diagnosis flow tests — focused coverage for POST /api/diagnosis/:id
 * and the resulting state visible via GET /api/incidents/:id.
 *
 * These tests use MemoryAdapter and ALLOW_INSECURE_DEV_MODE=true so no real
 * LLM calls are made. Auth-token tests temporarily set RECEIVER_AUTH_TOKEN.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryAdapter } from "../storage/adapters/memory.js";
import { createApp } from "../index.js";
import type { DiagnosisResult } from "@3am/core";

// ---------------------------------------------------------------------------
// Minimal OTLP payload to seed an incident
// ---------------------------------------------------------------------------
const errorSpanPayload = {
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "checkout-api" } },
          {
            key: "deployment.environment.name",
            value: { stringValue: "production" },
          },
        ],
      },
      scopeSpans: [
        {
          spans: [
            {
              traceId: "diag_trace_001",
              spanId: "diag_span_001",
              name: "POST /checkout",
              startTimeUnixNano: "1741392000000000000",
              endTimeUnixNano: "1741392000600000000",
              status: { code: 2 },
              attributes: [
                { key: "http.route", value: { stringValue: "/checkout" } },
                {
                  key: "http.response.status_code",
                  value: { intValue: 500 },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Valid DiagnosisResult fixture (matches DiagnosisResultSchema exactly)
// ---------------------------------------------------------------------------
function makeDiagnosisResult(incidentId: string): DiagnosisResult {
  return {
    summary: {
      what_happened: "Stripe rate limit caused checkout timeouts.",
      root_cause_hypothesis: "Fixed-interval retries amplified load under Stripe 429s.",
    },
    recommendation: {
      immediate_action: "Disable fixed retries and switch to exponential back-off.",
      action_rationale_short: "Fastest way to reduce Stripe request pressure.",
      do_not: "Do not restart the checkout service — it will not help.",
    },
    reasoning: {
      causal_chain: [
        { type: "external", title: "Stripe 429", detail: "Stripe begins rate-limiting" },
        { type: "system", title: "Retry amplification", detail: "Fixed retries multiply requests" },
        { type: "incident", title: "Queue depth climbs", detail: "In-flight request queue saturates" },
        { type: "impact", title: "Checkout 504", detail: "Customer-visible gateway timeout" },
      ],
    },
    operator_guidance: {
      watch_items: [
        { label: "Stripe error rate", state: "must drop below 1%", status: "watch" },
      ],
      operator_checks: ["Confirm queue depth returns to baseline within 60s"],
    },
    confidence: {
      confidence_assessment: "High — Stripe 429s are directly observable in traces.",
      uncertainty: "Stripe quota ceiling is not exposed in telemetry.",
    },
    metadata: {
      incident_id: incidentId,
      packet_id: "pkt_diag_test",
      model: "claude-sonnet-4-6",
      prompt_version: "v5",
      created_at: "2026-03-09T00:10:00Z",
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: seed an incident via /v1/traces and return its incidentId
// ---------------------------------------------------------------------------
async function seedIncident(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await app.request("/v1/traces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(errorSpanPayload),
  });
  const body = await res.json() as { incidentId: string };
  return body.incidentId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Diagnosis flow (POST /api/diagnosis/:id)", () => {
  let storage: MemoryAdapter;
  let app: ReturnType<typeof createApp>;
  const savedToken = process.env["RECEIVER_AUTH_TOKEN"];

  beforeEach(() => {
    delete process.env["RECEIVER_AUTH_TOKEN"];
    process.env["ALLOW_INSECURE_DEV_MODE"] = "true";
    storage = new MemoryAdapter();
    app = createApp(storage);
  });

  afterEach(() => {
    if (savedToken === undefined) {
      delete process.env["RECEIVER_AUTH_TOKEN"];
    } else {
      process.env["RECEIVER_AUTH_TOKEN"] = savedToken;
    }
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
  });

  // Test 1: valid DiagnosisResult → 200 → curated incident reflects diagnosis
  it("POST valid DiagnosisResult → 200 and GET curated incident reflects diagnosis", async () => {
    const incidentId = await seedIncident(app);
    const diagnosisResult = makeDiagnosisResult(incidentId);

    const postRes = await app.request(`/api/diagnosis/${incidentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(diagnosisResult),
    });
    expect(postRes.status).toBe(200);
    const postBody = await postRes.json() as { status: string };
    expect(postBody.status).toBe("ok");

    // GET the curated incident and verify diagnosis fields were projected
    const getRes = await app.request(`/api/incidents/${incidentId}`);
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json() as {
      incidentId: string;
      headline: string;
      action: { text: string };
      state: { diagnosis: string };
    };
    expect(getBody.incidentId).toBe(incidentId);
    expect(getBody.state.diagnosis).toBe("ready");
    expect(getBody.headline).toBe("Stripe rate limit caused checkout timeouts.");
    expect(getBody.action.text).toBe(
      "Disable fixed retries and switch to exponential back-off.",
    );
  });

  // Test 2: invalid body (missing required fields) → 400
  it("POST with invalid body (missing required fields) → 400", async () => {
    const incidentId = await seedIncident(app);

    const invalidBody = {
      // Missing most required fields — only has a partial summary
      summary: { what_happened: "Something broke." },
    };

    const res = await app.request(`/api/diagnosis/${incidentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(invalidBody),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBeDefined();
  });

  // Test 3: metadata.incident_id doesn't match :id URL param → 400
  it("POST where metadata.incident_id mismatches URL :id → 400", async () => {
    const incidentId = await seedIncident(app);
    // Create a result whose metadata.incident_id does NOT match the URL param
    const mismatchedResult = makeDiagnosisResult("inc_completely_different");

    const res = await app.request(`/api/diagnosis/${incidentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mismatchedResult),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/incident_id/);
  });

  // Test 4: RECEIVER_AUTH_TOKEN is set but no Bearer token in request → 401
  it("POST with RECEIVER_AUTH_TOKEN set but no Authorization header → 401", async () => {
    // Need to re-create app with auth token enabled
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
    process.env["RECEIVER_AUTH_TOKEN"] = "diagnosis-flow-secret";
    const authedStorage = new MemoryAdapter();
    const authedApp = createApp(authedStorage);

    const res = await authedApp.request("/api/diagnosis/inc_whatever", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeDiagnosisResult("inc_whatever")),
    });
    expect(res.status).toBe(401);
  });

  // Bonus: POST to non-existent incident → 404
  it("POST to non-existent incident :id → 404", async () => {
    const diagnosisResult = makeDiagnosisResult("inc_nonexistent");

    const res = await app.request("/api/diagnosis/inc_nonexistent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(diagnosisResult),
    });
    expect(res.status).toBe(404);
  });
});
