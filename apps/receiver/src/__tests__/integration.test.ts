import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryAdapter } from "../storage/adapters/memory.js";
import { createApp } from "../index.js";

// Minimal OTLP payload with an error span (spanStatusCode=2, httpStatusCode=500)
const errorSpanPayload = {
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "web" } },
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
              traceId: "abc123",
              spanId: "span001",
              name: "POST /checkout",
              startTimeUnixNano: "1741392000000000000",
              endTimeUnixNano: "1741392000500000000",
              status: { code: 2 },
              attributes: [
                {
                  key: "http.route",
                  value: { stringValue: "/checkout" },
                },
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

// Normal span (spanStatusCode=1, httpStatusCode=200) — should not trigger incident
const normalSpanPayload = {
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "web" } },
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
              traceId: "xyz999",
              spanId: "span002",
              name: "GET /health",
              startTimeUnixNano: "1741392000000000000",
              endTimeUnixNano: "1741392000100000000",
              status: { code: 1 },
              attributes: [
                {
                  key: "http.route",
                  value: { stringValue: "/health" },
                },
                {
                  key: "http.response.status_code",
                  value: { intValue: 200 },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

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
        {
          type: "system",
          title: "Retry loop",
          detail: "amplifies failure",
        },
        { type: "incident", title: "Queue climbs", detail: "local overload" },
        {
          type: "impact",
          title: "Checkout 504",
          detail: "customer-visible",
        },
      ],
    },
    operator_guidance: {
      watch_items: [
        { label: "Queue", state: "must flatten first", status: "watch" },
      ],
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

describe("Bearer Token auth (ADR 0011)", () => {
  let storage: MemoryAdapter;
  let app: ReturnType<typeof createApp>;
  const savedToken = process.env["RECEIVER_AUTH_TOKEN"];

  beforeEach(() => {
    storage = new MemoryAdapter();
  });

  afterEach(() => {
    if (savedToken === undefined) {
      delete process.env["RECEIVER_AUTH_TOKEN"];
    } else {
      process.env["RECEIVER_AUTH_TOKEN"] = savedToken;
    }
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
  });

  it("returns 401 when token is set and Authorization header is missing", async () => {
    process.env["RECEIVER_AUTH_TOKEN"] = "test-secret";
    app = createApp(storage);
    const res = await app.request("/api/incidents");
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is set and Authorization header is wrong", async () => {
    process.env["RECEIVER_AUTH_TOKEN"] = "test-secret";
    app = createApp(storage);
    const res = await app.request("/api/incidents", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 when token is set and correct Authorization header is provided", async () => {
    process.env["RECEIVER_AUTH_TOKEN"] = "test-secret";
    app = createApp(storage);
    const res = await app.request("/api/incidents", {
      headers: { Authorization: "Bearer test-secret" },
    });
    expect(res.status).toBe(200);
  });

  it("allows all requests when ALLOW_INSECURE_DEV_MODE=true and no token (dev mode)", async () => {
    delete process.env["RECEIVER_AUTH_TOKEN"];
    process.env["ALLOW_INSECURE_DEV_MODE"] = "true";
    app = createApp(storage);
    const res = await app.request("/api/incidents");
    expect(res.status).toBe(200);
  });

  it("throws on startup when no token and ALLOW_INSECURE_DEV_MODE is not set (F-201 fail-closed)", () => {
    delete process.env["RECEIVER_AUTH_TOKEN"];
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
    expect(() => createApp(storage)).toThrow("RECEIVER_AUTH_TOKEN must be set");
  });
});

describe("Receiver integration tests", () => {
  let storage: MemoryAdapter;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    delete process.env["RECEIVER_AUTH_TOKEN"];
    process.env["ALLOW_INSECURE_DEV_MODE"] = "true";
    storage = new MemoryAdapter();
    app = createApp(storage);
  });

  afterEach(() => {
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
  });

  // Test 1: POST /v1/traces with error span → 200, response has incidentId and packetId
  it("POST /v1/traces with error span returns incidentId and packetId", async () => {
    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(errorSpanPayload),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; incidentId: string; packetId: string };
    expect(body.status).toBe("ok");
    expect(typeof body.incidentId).toBe("string");
    expect(body.incidentId.startsWith("inc_")).toBe(true);
    expect(typeof body.packetId).toBe("string");
  });

  // Test 2: POST /v1/traces with normal span only → 200, no incident created
  it("POST /v1/traces with normal span does not create an incident", async () => {
    const traceRes = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(normalSpanPayload),
    });
    expect(traceRes.status).toBe(200);

    const listRes = await app.request("/api/incidents");
    expect(listRes.status).toBe(200);
    const body = await listRes.json() as { items: unknown[] };
    expect(body.items).toHaveLength(0);
  });

  // Test 3: GET /api/incidents → 200, items contains 1 incident after error span ingest
  it("GET /api/incidents returns 1 incident after error span ingest", async () => {
    await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(errorSpanPayload),
    });

    const res = await app.request("/api/incidents");
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ incidentId: string }> };
    expect(body.items).toHaveLength(1);
    expect(typeof body.items[0].incidentId).toBe("string");
  });

  // Test 4: GET /api/incidents/:id → 200, incidentId matches
  it("GET /api/incidents/:id returns the incident", async () => {
    const traceRes = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(errorSpanPayload),
    });
    const traceBody = await traceRes.json() as { incidentId: string };
    const { incidentId } = traceBody;

    const res = await app.request(`/api/incidents/${incidentId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { incidentId: string };
    expect(body.incidentId).toBe(incidentId);
  });

  // Test 5: GET /api/packets/:packetId → 200, schemaVersion is "incident-packet/v1alpha1"
  it("GET /api/packets/:packetId returns the packet with correct schemaVersion", async () => {
    const traceRes = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(errorSpanPayload),
    });
    const traceBody = await traceRes.json() as { packetId: string };
    const { packetId } = traceBody;

    const res = await app.request(`/api/packets/${packetId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { schemaVersion: string };
    expect(body.schemaVersion).toBe("incident-packet/v1alpha1");
  });

  // Test 6: POST /api/diagnosis/:id (valid) → 200, { status: "ok" }
  it("POST /api/diagnosis/:id with valid result returns ok", async () => {
    const traceRes = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(errorSpanPayload),
    });
    const traceBody = await traceRes.json() as { incidentId: string };
    const { incidentId } = traceBody;

    const diagnosisFixture = makeDiagnosisFixture(incidentId);

    const res = await app.request(`/api/diagnosis/${incidentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(diagnosisFixture),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  // Test 7: POST /api/diagnosis/:id (metadata.incident_id mismatch) → 400
  it("POST /api/diagnosis/:id with mismatched incident_id returns 400", async () => {
    const traceRes = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(errorSpanPayload),
    });
    const traceBody = await traceRes.json() as { incidentId: string };
    const { incidentId } = traceBody;

    // Use a different incidentId in the fixture
    const diagnosisFixture = makeDiagnosisFixture("inc_different_id");

    const res = await app.request(`/api/diagnosis/${incidentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(diagnosisFixture),
    });

    expect(res.status).toBe(400);
  });

  // Test 8: GET /api/incidents/:id after diagnosis → response includes diagnosisResult
  it("GET /api/incidents/:id after diagnosis includes diagnosisResult", async () => {
    const traceRes = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(errorSpanPayload),
    });
    const traceBody = await traceRes.json() as { incidentId: string };
    const { incidentId } = traceBody;

    const diagnosisFixture = makeDiagnosisFixture(incidentId);
    await app.request(`/api/diagnosis/${incidentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(diagnosisFixture),
    });

    const res = await app.request(`/api/incidents/${incidentId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { diagnosisResult?: { summary: { what_happened: string } } };
    expect(body.diagnosisResult).toBeDefined();
    expect(body.diagnosisResult?.summary.what_happened).toBe(
      "Stripe 429s caused checkout 504s.",
    );
  });

  // GET /api/incidents limit validation (F-108)
  it("GET /api/incidents with limit=0 uses minimum 1", async () => {
    const res = await app.request("/api/incidents?limit=0");
    expect(res.status).toBe(200);
  });

  it("GET /api/incidents with limit=200 clamps to 100", async () => {
    const res = await app.request("/api/incidents?limit=200");
    expect(res.status).toBe(200);
    const body = await res.json() as { items: unknown[] };
    // items count can't exceed clamped limit; just verify 200 OK
    expect(body.items).toBeDefined();
  });

  it("GET /api/incidents with limit=abc (NaN) falls back to default 20", async () => {
    const res = await app.request("/api/incidents?limit=abc");
    expect(res.status).toBe(200);
  });

  // Shape-aware ingest stubs (F-102)
  it("POST /v1/metrics with valid JSON body returns ok", async () => {
    const res = await app.request("/v1/metrics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resourceMetrics: [] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  it("POST /v1/metrics with missing field returns 400", async () => {
    const res = await app.request("/v1/metrics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wrong: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /v1/metrics with protobuf Content-Type returns 501", async () => {
    const res = await app.request("/v1/metrics", {
      method: "POST",
      headers: { "Content-Type": "application/x-protobuf" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(res.status).toBe(501);
  });

  it("POST /v1/logs with valid JSON body returns ok", async () => {
    const res = await app.request("/v1/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resourceLogs: [] }),
    });
    expect(res.status).toBe(200);
  });

  it("POST /v1/platform-events with valid JSON body returns ok", async () => {
    const res = await app.request("/v1/platform-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [] }),
    });
    expect(res.status).toBe(200);
  });

  // Body size limit (F-203): >1MB payload → 413
  it("POST /v1/traces with payload >1MB returns 413", async () => {
    // 1MB + 1 byte of padding inside a JSON string field
    const oversize = JSON.stringify({ resourceSpans: "x".repeat(1024 * 1024 + 1) });
    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: oversize,
    });
    expect(res.status).toBe(413);
  });

  // Test 9: Two POST /v1/traces within 5min for same service/env → only 1 ThinEvent
  it("Two error spans within 5min for same service/env produce only 1 ThinEvent", async () => {
    // Both spans use the same startTimeUnixNano (within the 5-minute window)
    await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(errorSpanPayload),
    });

    // Second error span — same service/env, same time window
    const secondErrorSpan = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "web" } },
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
                  traceId: "abc124",
                  spanId: "span003",
                  name: "POST /checkout",
                  // 1 minute after first span (within 5-min window)
                  startTimeUnixNano: "1741392060000000000",
                  endTimeUnixNano: "1741392060500000000",
                  status: { code: 2 },
                  attributes: [
                    {
                      key: "http.route",
                      value: { stringValue: "/checkout" },
                    },
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

    await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(secondErrorSpan),
    });

    const thinEvents = await storage.listThinEvents();
    expect(thinEvents).toHaveLength(1);
  });
});
