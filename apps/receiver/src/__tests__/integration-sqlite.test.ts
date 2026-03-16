/**
 * Integration tests: full OTLP ingest flow with SQLiteAdapter (better-sqlite3, :memory:).
 *
 * Verifies JSON serialisation/deserialisation round-trips through the entire
 * POST /v1/traces -> anomaly detection -> packetizer -> SQLite -> API response path.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SQLiteAdapter } from "../storage/drizzle/sqlite.js";
import { createApp } from "../index.js";

// ── OTLP payload ────────────────────────────────────────────────────────────────
const errorSpanPayload = {
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "web" } },
          { key: "deployment.environment.name", value: { stringValue: "production" } },
        ],
      },
      scopeSpans: [
        {
          spans: [
            {
              traceId: "abc123",
              spanId: "span001",
              name: "POST /checkout",
              startTimeUnixNano: "1741392000000000000",
              endTimeUnixNano: "1741392000500000000",
              status: { code: 2 },
              attributes: [
                { key: "http.route", value: { stringValue: "/checkout" } },
                { key: "http.response.status_code", value: { intValue: 500 } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

// ── Diagnosis fixture ───────────────────────────────────────────────────────────
function makeDiagnosisFixture(incidentId: string) {
  return {
    summary: {
      what_happened: "Stripe 429s caused checkout 504s.",
      root_cause_hypothesis: "Fixed retries amplified the failure.",
    },
    recommendation: {
      immediate_action: "Disable fixed retries.",
      action_rationale_short: "Fastest control point.",
      do_not: "Do not restart blindly.",
    },
    reasoning: {
      causal_chain: [
        { type: "external", title: "Stripe 429", detail: "rate limit begins" },
        { type: "system", title: "Retry loop", detail: "amplifies failure" },
        { type: "incident", title: "Queue climbs", detail: "local overload" },
        { type: "impact", title: "Checkout 504", detail: "customer-visible" },
      ],
    },
    operator_guidance: {
      watch_items: [{ label: "Queue", state: "must flatten first", status: "watch" }],
      operator_checks: ["Confirm queue depth flattens within 30s"],
    },
    confidence: {
      confidence_assessment: "High confidence.",
      uncertainty: "Stripe quota not visible in telemetry.",
    },
    metadata: {
      incident_id: incidentId,
      packet_id: "pkt_test",
      model: "claude-sonnet-4-6",
      prompt_version: "v5",
      created_at: "2026-03-08T12:00:00Z",
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────────
async function postTraces(app: ReturnType<typeof createApp>) {
  const res = await app.request("/v1/traces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(errorSpanPayload),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { status: string; incidentId: string; packetId: string };
}

// ── Tests ───────────────────────────────────────────────────────────────────────
describe("Integration: SQLite full ingest flow", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    delete process.env["RECEIVER_AUTH_TOKEN"];
    process.env["ALLOW_INSECURE_DEV_MODE"] = "true";
    // SQLiteAdapter constructor auto-migrates, no migrate() needed
    const storage = new SQLiteAdapter(":memory:");
    app = createApp(storage);
  });

  afterEach(() => {
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
  });

  // Test 1: OTLP error span -> incident created -> rawState has spans
  it("OTLP error span creates incident with rawState spans and anomalousSignals", async () => {
    const { incidentId } = await postTraces(app);

    const res = await app.request(`/api/incidents/${incidentId}/raw`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      incidentId: string;
      rawState: { spans: unknown[]; anomalousSignals: unknown[] };
    };
    expect(body.incidentId).toBe(incidentId);
    expect(body.rawState.spans.length).toBeGreaterThan(0);
    expect(body.rawState.anomalousSignals.length).toBeGreaterThan(0);
  });

  // Test 2: GET /api/incidents/:id returns incident without rawState
  it("GET /api/incidents/:id returns incident without rawState", async () => {
    const { incidentId } = await postTraces(app);

    const res = await app.request(`/api/incidents/${incidentId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { incidentId: string; rawState?: unknown };
    expect(body.incidentId).toBe(incidentId);
    expect(body.rawState).toBeUndefined();
  });

  // Test 3: GET /api/packets/:packetId returns packet with correct schemaVersion
  it("GET /api/packets/:packetId returns packet with schemaVersion incident-packet/v1alpha1", async () => {
    const { packetId } = await postTraces(app);

    const res = await app.request(`/api/packets/${packetId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { schemaVersion: string };
    expect(body.schemaVersion).toBe("incident-packet/v1alpha1");
  });

  // Test 4: appendDiagnosis -> getIncident has diagnosisResult
  it("POST diagnosis then GET incident returns diagnosisResult", async () => {
    const { incidentId } = await postTraces(app);

    const diagnosisFixture = makeDiagnosisFixture(incidentId);
    const diagRes = await app.request(`/api/diagnosis/${incidentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(diagnosisFixture),
    });
    expect(diagRes.status).toBe(200);

    const res = await app.request(`/api/incidents/${incidentId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      diagnosisResult?: { summary: { what_happened: string } };
    };
    expect(body.diagnosisResult).toBeDefined();
    expect(body.diagnosisResult?.summary.what_happened).toBe(
      "Stripe 429s caused checkout 504s.",
    );
  });

  // Test 5: upsert preserves rawState and diagnosisResult
  // The payload uses a fixed past timestamp (startTimeUnixNano "1741392000000000000").
  // shouldAttachToIncident uses signalTimeMs from that span — not wall clock — so
  // the second POST always falls within the 5-minute FORMATION_WINDOW_MS of the first.
  it("second OTLP POST (upsert) preserves rawState and diagnosisResult", async () => {
    // Step 1: create incident via error span
    const { incidentId } = await postTraces(app);

    // Record initial span count for accumulation assertion
    const initialRaw = await app.request(`/api/incidents/${incidentId}/raw`);
    const initialBody = (await initialRaw.json()) as {
      rawState: { spans: unknown[] };
    };
    const initialSpanCount = initialBody.rawState.spans.length;
    expect(initialSpanCount).toBeGreaterThan(0);

    // Step 2: append diagnosis
    const diagnosisFixture = makeDiagnosisFixture(incidentId);
    const diagRes = await app.request(`/api/diagnosis/${incidentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(diagnosisFixture),
    });
    expect(diagRes.status).toBe(200);

    // Step 3: send same OTLP payload again (triggers upsert via shouldAttachToIncident)
    const res2 = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(errorSpanPayload),
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { incidentId: string };
    // Same incident reused (formation key matches within 5-minute window)
    expect(body2.incidentId).toBe(incidentId);

    // Step 4: verify rawState still has spans
    const rawRes = await app.request(`/api/incidents/${incidentId}/raw`);
    expect(rawRes.status).toBe(200);
    const rawBody = (await rawRes.json()) as {
      incidentId: string;
      rawState: { spans: unknown[]; anomalousSignals: unknown[] };
      diagnosisResult?: { summary: { what_happened: string } };
    };
    // Spans accumulated (second batch appended, not replaced)
    expect(rawBody.rawState.spans.length).toBeGreaterThan(initialSpanCount);
    expect(rawBody.rawState.anomalousSignals.length).toBeGreaterThan(0);

    // Step 5: verify diagnosisResult preserved through upsert
    expect(rawBody.diagnosisResult).toBeDefined();
    expect(rawBody.diagnosisResult?.summary.what_happened).toBe(
      "Stripe 429s caused checkout 504s.",
    );
  });
});
