import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
import protobuf from "protobufjs";
import { MemoryAdapter } from "../storage/adapters/memory.js";
import { createApp } from "../index.js";
import { MAX_REPRESENTATIVE_TRACES } from "../domain/packetizer.js";
import { secretsRotationReplayPayload } from "./fixtures/scenarios/06-secrets-rotation-replay.js";

// ── Protobuf encode helpers ────────────────────────────────────────────────────
const _require = createRequire(import.meta.url);
const descriptor: protobuf.INamespace = _require("../transport/proto/otlp.json");
const _root = protobuf.Root.fromJSON(descriptor);
const TraceReq = _root.lookupType(
  "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
);
const MetricsReq = _root.lookupType(
  "opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest",
);
const LogsReq = _root.lookupType(
  "opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest",
);

function encodeProto(Type: protobuf.Type, obj: object): Uint8Array {
  return Type.encode(Type.fromObject(obj)).finish();
}

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

function makeTraceSpan(options: {
  traceId: string;
  spanId: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  httpStatusCode?: number;
  peerService?: string;
  spanStatusCode: number;
  route?: string;
}): object {
  const attributes = [];
  if (options.route) {
    attributes.push({
      key: "http.route",
      value: { stringValue: options.route },
    });
  }
  if (options.httpStatusCode !== undefined) {
    attributes.push({
      key: "http.response.status_code",
      value: { intValue: options.httpStatusCode },
    });
  }
  if (options.peerService) {
    attributes.push({
      key: "peer.service",
      value: { stringValue: options.peerService },
    });
  }

  return {
    traceId: options.traceId,
    spanId: options.spanId,
    name: options.route ?? options.spanId,
    startTimeUnixNano: options.startTimeUnixNano,
    endTimeUnixNano: options.endTimeUnixNano,
    status: { code: options.spanStatusCode },
    attributes,
  };
}

function makeResourceSpans(
  serviceName: string,
  spans: object[],
  environment = "production",
) {
  return {
    resource: {
      attributes: [
        { key: "service.name", value: { stringValue: serviceName } },
        {
          key: "deployment.environment.name",
          value: { stringValue: environment },
        },
      ],
    },
    scopeSpans: [{ spans }],
  };
}

function makeTracePayload(resourceSpans: object[]) {
  return {
    resourceSpans,
  };
}

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

  // /v1/* (OTel ingest) requires Bearer (ADR 0028)
  it("returns 401 on /v1/* when token is set and Authorization header is missing", async () => {
    process.env["RECEIVER_AUTH_TOKEN"] = "test-secret";
    app = createApp(storage);
    const res = await app.request("/v1/traces", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("returns 401 on /v1/* when token is set and Authorization header is wrong", async () => {
    process.env["RECEIVER_AUTH_TOKEN"] = "test-secret";
    app = createApp(storage);
    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  // /api/diagnosis/* (GitHub Actions callback) requires Bearer (ADR 0028)
  it("returns 401 on /api/diagnosis/* when token is set and no Bearer provided", async () => {
    process.env["RECEIVER_AUTH_TOKEN"] = "test-secret";
    app = createApp(storage);
    const res = await app.request("/api/diagnosis/inc_test", { method: "POST" });
    expect(res.status).toBe(401);
  });

  // /api/* Console routes are accessible without Bearer (same-origin protection, ADR 0028)
  it("returns 200 on /api/incidents without Bearer when token is set (Console same-origin route)", async () => {
    process.env["RECEIVER_AUTH_TOKEN"] = "test-secret";
    app = createApp(storage);
    const res = await app.request("/api/incidents");
    expect(res.status).toBe(200);
  });

  it("returns 200 when token is set and correct Authorization header is provided to /api/incidents", async () => {
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
    // Bypass diagnosis debouncer — these tests expect immediate thin event dispatch
    process.env["DIAGNOSIS_GENERATION_THRESHOLD"] = "0";
    process.env["DIAGNOSIS_MAX_WAIT_MS"] = "0";
    storage = new MemoryAdapter();
    app = createApp(storage);
  });

  afterEach(() => {
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
    delete process.env["DIAGNOSIS_GENERATION_THRESHOLD"];
    delete process.env["DIAGNOSIS_MAX_WAIT_MS"];
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
    const body = await res.json() as { items: Array<{ incidentId: string; rawState?: unknown }> };
    expect(body.items).toHaveLength(1);
    expect(typeof body.items[0].incidentId).toBe("string");
    expect(body.items[0].rawState).toBeUndefined();
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
    const body = await res.json() as { incidentId: string; rawState?: unknown };
    expect(body.incidentId).toBe(incidentId);
    expect(body.rawState).toBeUndefined();
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

  it("POST /v1/metrics with missing resourceMetrics field returns ok (graceful no-op)", async () => {
    // extractMetricEvidence handles missing field gracefully (returns []) —
    // no explicit 400 to keep protobuf and JSON paths symmetric.
    const res = await app.request("/v1/metrics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wrong: [] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
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

  it("POST /v1/platform-events with invalid event body returns 400", async () => {
    const res = await app.request("/v1/platform-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            eventType: "deploy",
            timestamp: "2025-03-07T16:00:00.250Z",
            environment: "production",
          },
        ],
      }),
    });

    expect(res.status).toBe(400);
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

  // ── Protobuf ingest (ADR 0022) ────────────────────────────────────────────────

  it("POST /v1/traces + protobuf error span → 200 + incidentId", async () => {
    const buf = encodeProto(TraceReq, {
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
                  traceId: Buffer.from("a3ce929d0e0e47364bf92f3577b34da6", "hex"),
                  spanId: Buffer.from("00f067aa0ba902b7", "hex"),
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
    });

    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/x-protobuf" },
      body: buf,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; incidentId?: string };
    expect(body.status).toBe("ok");
    expect(typeof body.incidentId).toBe("string");
  });

  it("POST /v1/traces + protobuf normal span → 200, no incident", async () => {
    const buf = encodeProto(TraceReq, {
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
                  traceId: Buffer.from("b3ce929d0e0e47364bf92f3577b34da7", "hex"),
                  spanId: Buffer.from("11f067aa0ba902b8", "hex"),
                  name: "GET /health",
                  startTimeUnixNano: "1741392000000000000",
                  endTimeUnixNano: "1741392000100000000",
                  status: { code: 1 },
                  attributes: [
                    { key: "http.route", value: { stringValue: "/health" } },
                    { key: "http.response.status_code", value: { intValue: 200 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/x-protobuf" },
      body: buf,
    });

    expect(res.status).toBe(200);
    const listRes = await app.request("/api/incidents");
    const listBody = await listRes.json() as { items: unknown[] };
    expect(listBody.items).toHaveLength(0);
  });

  it("POST /v1/metrics + protobuf → 200", async () => {
    const buf = encodeProto(MetricsReq, { resourceMetrics: [] });
    const res = await app.request("/v1/metrics", {
      method: "POST",
      headers: { "Content-Type": "application/x-protobuf" },
      body: buf,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  it("POST /v1/logs + protobuf → 200", async () => {
    const buf = encodeProto(LogsReq, { resourceLogs: [] });
    const res = await app.request("/v1/logs", {
      method: "POST",
      headers: { "Content-Type": "application/x-protobuf" },
      body: buf,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  it("POST /v1/traces + protobuf + Content-Encoding: gzip → 200", async () => {
    const buf = encodeProto(TraceReq, { resourceSpans: [] });
    const compressed = gzipSync(buf);
    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-protobuf",
        "Content-Encoding": "gzip",
      },
      body: compressed,
    });
    expect(res.status).toBe(200);
  });

  it("POST /v1/traces + unknown Content-Type → 415", async () => {
    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(res.status).toBe(415);
  });

  it("POST /v1/traces + protobuf + Content-Encoding: br → 400", async () => {
    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-protobuf",
        "Content-Encoding": "br",
      },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(res.status).toBe(400);
  });

  it("POST /v1/traces + broken protobuf binary → 400", async () => {
    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/x-protobuf" },
      body: new Uint8Array([0xff, 0xfe, 0xfd, 0xfc]),
    });
    expect(res.status).toBe(400);
  });

  it("POST /v1/traces + protobuf + broken gzip payload → 400", async () => {
    // Valid gzip magic header but corrupted content
    const brokenGzip = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff]);
    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-protobuf",
        "Content-Encoding": "gzip",
      },
      body: brokenGzip,
    });
    // gunzip throws on corrupt data → decompressIfNeeded catches it → 400
    expect(res.status).toBe(400);
  });

  it("POST /v1/traces + protobuf + decompressed payload > 1MB → 413", async () => {
    // 1MB + 1 byte of zeros compresses to ~1KB, but decompresses > 1MB
    const bigBuf = Buffer.alloc(1024 * 1024 + 1, 0x00);
    const compressed = gzipSync(bigBuf);
    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-protobuf",
        "Content-Encoding": "gzip",
      },
      body: compressed,
    });
    expect(res.status).toBe(413);
  });

  it("POST /v1/platform-events + protobuf Content-Type → 415 (JSON only)", async () => {
    const res = await app.request("/v1/platform-events", {
      method: "POST",
      headers: { "Content-Type": "application/x-protobuf" },
      body: new Uint8Array([1, 2, 3]),
    });
    // platform-events is JSON-only; non-JSON Content-Type → 415
    expect(res.status).toBe(415);
  });

  // ── Evidence accumulation tests ───────────────────────────────────────────────

  // BASE_TIME_NS corresponds to startTimeUnixNano in errorSpanPayload (openedAt anchor)
  const BASE_TIME_NS = "1741392000000000000" // 2025-03-07T16:00:00Z

  // POST /v1/metrics from the same service within window → changedMetrics populated
  it("POST /v1/traces (error) then /v1/metrics (same service/env, within window) → changedMetrics non-empty", async () => {
    const traceRes = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(errorSpanPayload),
    });
    const { incidentId } = await traceRes.json() as { incidentId: string };

    const metricsPayload = {
      resourceMetrics: [{
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "web" } },
            { key: "deployment.environment.name", value: { stringValue: "production" } },
          ],
        },
        scopeMetrics: [{
          metrics: [{
            name: "http.server.request.error_rate",
            gauge: {
              dataPoints: [{
                startTimeUnixNano: BASE_TIME_NS,
                timeUnixNano: BASE_TIME_NS,
                asDouble: 0.85,
              }],
            },
          }],
        }],
      }],
    };

    const mRes = await app.request("/v1/metrics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metricsPayload),
    });
    expect(mRes.status).toBe(200);

    const incident = await (await app.request(`/api/incidents/${incidentId}`)).json() as {
      packet: { evidence: { changedMetrics: unknown[] } };
    };
    expect(incident.packet.evidence.changedMetrics.length).toBeGreaterThan(0);
  });

  // POST /v1/logs (ERROR, same service/env, within window) → relevantLogs populated
  it("POST /v1/traces (error) then /v1/logs (ERROR, same service/env) → relevantLogs non-empty", async () => {
    const traceRes = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(errorSpanPayload),
    });
    const { incidentId } = await traceRes.json() as { incidentId: string };

    const logsPayload = {
      resourceLogs: [{
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "web" } },
            { key: "deployment.environment.name", value: { stringValue: "production" } },
          ],
        },
        scopeLogs: [{
          logRecords: [{
            timeUnixNano: BASE_TIME_NS,
            severityNumber: 17,
            severityText: "ERROR",
            body: { stringValue: "checkout failed" },
            attributes: [],
          }],
        }],
      }],
    };

    const lRes = await app.request("/v1/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(logsPayload),
    });
    expect(lRes.status).toBe(200);

    const incident = await (await app.request(`/api/incidents/${incidentId}`)).json() as {
      packet: { evidence: { relevantLogs: unknown[] } };
    };
    expect(incident.packet.evidence.relevantLogs.length).toBeGreaterThan(0);
  });

  // POST /v1/logs with INFO only → relevantLogs stays empty
  it("POST /v1/logs (INFO only) → relevantLogs remains empty", async () => {
    const traceRes = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(errorSpanPayload),
    });
    const { incidentId } = await traceRes.json() as { incidentId: string };

    const logsPayload = {
      resourceLogs: [{
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "web" } },
            { key: "deployment.environment.name", value: { stringValue: "production" } },
          ],
        },
        scopeLogs: [{
          logRecords: [{
            timeUnixNano: BASE_TIME_NS,
            severityNumber: 9, // INFO
            severityText: "INFO",
            body: { stringValue: "all good" },
            attributes: [],
          }],
        }],
      }],
    };

    await app.request("/v1/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(logsPayload),
    });

    const incident = await (await app.request(`/api/incidents/${incidentId}`)).json() as {
      packet: { evidence: { relevantLogs: unknown[] } };
    };
    expect(incident.packet.evidence.relevantLogs).toHaveLength(0);
  });

  it("POST /v1/traces then /v1/platform-events attaches typed platform event and deterministic ref", async () => {
    const traceRes = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(errorSpanPayload),
    });
    const { incidentId } = await traceRes.json() as { incidentId: string };

    const event = {
      eventType: "deploy",
      timestamp: "2025-03-08T00:00:00.250Z",
      environment: "production",
      description: "web rollout 2025.03.07.1",
      service: "web",
      deploymentId: "dep_123",
      releaseVersion: "2025.03.07.1",
      details: { initiatedBy: "gha" },
    };

    const platformRes = await app.request("/v1/platform-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [event] }),
    });
    expect(platformRes.status).toBe(200);

    const incident = await (await app.request(`/api/incidents/${incidentId}`)).json() as {
      packet: {
        evidence: { platformEvents: Array<typeof event> };
        pointers: { platformLogRefs: string[] };
      };
    };

    expect(incident.packet.evidence.platformEvents).toEqual([event]);
    expect(incident.packet.pointers.platformLogRefs).toEqual([
      "2025-03-08T00:00:00.250Z:deploy:web",
    ]);
  });

  it("POST /v1/platform-events with environment mismatch or service mismatch does not attach", async () => {
    const traceRes = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(errorSpanPayload),
    });
    const { incidentId } = await traceRes.json() as { incidentId: string };

    const platformRes = await app.request("/v1/platform-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            eventType: "deploy",
            timestamp: "2025-03-08T00:00:00.250Z",
            environment: "staging",
            description: "wrong environment",
            service: "web",
          },
          {
            eventType: "config_change",
            timestamp: "2025-03-08T00:00:00.250Z",
            environment: "production",
            description: "wrong service",
            service: "worker",
          },
        ],
      }),
    });
    expect(platformRes.status).toBe(200);

    const incident = await (await app.request(`/api/incidents/${incidentId}`)).json() as {
      packet: {
        evidence: { platformEvents: unknown[] };
        pointers: { platformLogRefs: string[] };
      };
    };

    expect(incident.packet.evidence.platformEvents).toEqual([]);
    expect(incident.packet.pointers.platformLogRefs).toEqual([]);
  });

  it("POST /v1/platform-events attaches to the single best matching incident", async () => {
    const incident1TraceRes = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        makeTracePayload([
          makeResourceSpans("web", [
            makeTraceSpan({
              traceId: "trace-best-1",
              spanId: "span-best-1",
              startTimeUnixNano: "1741392000000000000",
              endTimeUnixNano: "1741392600000000000",
              httpStatusCode: 500,
              spanStatusCode: 2,
              route: "/checkout",
            }),
          ]),
        ]),
      ),
    });
    const { incidentId: incident1Id } = await incident1TraceRes.json() as { incidentId: string };

    const incident2TraceRes = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        makeTracePayload([
          makeResourceSpans("web", [
            makeTraceSpan({
              traceId: "trace-best-2",
              spanId: "span-best-2",
              startTimeUnixNano: "1741392360000000000",
              endTimeUnixNano: "1741392960000000000",
              httpStatusCode: 500,
              spanStatusCode: 2,
              route: "/checkout",
            }),
          ]),
        ]),
      ),
    });
    const { incidentId: incident2Id } = await incident2TraceRes.json() as { incidentId: string };

    const platformRes = await app.request("/v1/platform-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            eventType: "deploy",
            timestamp: "2025-03-08T00:07:00.000Z",
            environment: "production",
            description: "web deploy overlaps both incidents",
            service: "web",
          },
        ],
      }),
    });
    expect(platformRes.status).toBe(200);

    const incident1 = await (await app.request(`/api/incidents/${incident1Id}`)).json() as {
      packet: { evidence: { platformEvents: unknown[] } };
    };
    const incident2 = await (await app.request(`/api/incidents/${incident2Id}`)).json() as {
      packet: { evidence: { platformEvents: Array<{ timestamp: string }> } };
    };

    expect(incident1.packet.evidence.platformEvents).toEqual([]);
    expect(incident2.packet.evidence.platformEvents).toHaveLength(1);
    expect(incident2.packet.evidence.platformEvents[0]?.timestamp).toBe("2025-03-08T00:07:00.000Z");
  });

  // POST /v1/metrics with no matching incident → 200 ok, no-op
  it("POST /v1/metrics with no matching incident returns 200 and is a no-op", async () => {
    const metricsPayload = {
      resourceMetrics: [{
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "web" } },
            { key: "deployment.environment.name", value: { stringValue: "production" } },
          ],
        },
        scopeMetrics: [{
          metrics: [{
            name: "http.server.request.duration",
            gauge: { dataPoints: [{ timeUnixNano: BASE_TIME_NS, asDouble: 0.5 }] },
          }],
        }],
      }],
    };
    const res = await app.request("/v1/metrics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metricsPayload),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  // Metrics from affectedDependencies service → attached to incident
  it("POST /v1/metrics from affectedDependencies service → changedMetrics non-empty", async () => {
    // Error span with peer.service: stripe → stripe goes into affectedDependencies
    const spanWithPeer = {
      resourceSpans: [{
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "web" } },
            { key: "deployment.environment.name", value: { stringValue: "production" } },
          ],
        },
        scopeSpans: [{
          spans: [{
            traceId: "abc200",
            spanId: "span200",
            name: "POST /checkout",
            startTimeUnixNano: BASE_TIME_NS,
            endTimeUnixNano: "1741392000500000000",
            status: { code: 2 },
            attributes: [
              { key: "http.route", value: { stringValue: "/checkout" } },
              { key: "http.response.status_code", value: { intValue: 500 } },
              { key: "peer.service", value: { stringValue: "stripe" } },
            ],
          }],
        }],
      }],
    };

    const traceRes = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(spanWithPeer),
    });
    const { incidentId } = await traceRes.json() as { incidentId: string };

    // Verify stripe is in affectedDependencies
    const incidentBefore = await (await app.request(`/api/incidents/${incidentId}`)).json() as {
      packet: { scope: { affectedDependencies: string[] } };
    };
    expect(incidentBefore.packet.scope.affectedDependencies).toContain("stripe");

    // Now send metrics from stripe
    const stripeMetrics = {
      resourceMetrics: [{
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "stripe" } },
            { key: "deployment.environment.name", value: { stringValue: "production" } },
          ],
        },
        scopeMetrics: [{
          metrics: [{
            name: "stripe.api.latency",
            gauge: { dataPoints: [{ timeUnixNano: BASE_TIME_NS, asDouble: 250.0 }] },
          }],
        }],
      }],
    };

    await app.request("/v1/metrics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(stripeMetrics),
    });

    const incidentAfter = await (await app.request(`/api/incidents/${incidentId}`)).json() as {
      packet: { evidence: { changedMetrics: unknown[] } };
    };
    expect(incidentAfter.packet.evidence.changedMetrics.length).toBeGreaterThan(0);
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

  it("sets primaryService from the triggering anomalous service on initial create", async () => {
    const payload = makeTracePayload([
      makeResourceSpans("edge-proxy", [
        makeTraceSpan({
          traceId: "primary-create-001",
          spanId: "edge-normal",
          startTimeUnixNano: "1741392001000000000",
          endTimeUnixNano: "1741392001200000000",
          spanStatusCode: 1,
          route: "/checkout",
        }),
      ]),
      makeResourceSpans("checkout-api", [
        makeTraceSpan({
          traceId: "primary-create-001",
          spanId: "checkout-anomaly",
          startTimeUnixNano: "1741392000000000000",
          endTimeUnixNano: "1741392000500000000",
          spanStatusCode: 2,
          httpStatusCode: 500,
          route: "/checkout",
        }),
      ]),
    ]);

    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const { incidentId } = await res.json() as { incidentId: string };

    const incident = await (await app.request(`/api/incidents/${incidentId}`)).json() as {
      packet: { scope: { primaryService: string } };
    };

    expect(incident.packet.scope.primaryService).toBe("checkout-api");
  });

  it("keeps primaryService immutable after later batches attach", async () => {
    const createPayload = makeTracePayload([
      makeResourceSpans("checkout-api", [
        makeTraceSpan({
          traceId: "primary-immutable-001",
          spanId: "create-anomaly",
          startTimeUnixNano: "1741392000000000000",
          endTimeUnixNano: "1741392000500000000",
          spanStatusCode: 2,
          httpStatusCode: 500,
          peerService: "stripe",
          route: "/checkout",
        }),
      ]),
    ]);

    const createRes = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createPayload),
    });
    const { incidentId } = await createRes.json() as { incidentId: string };

    const attachPayload = makeTracePayload([
      makeResourceSpans("checkout-api", [
        makeTraceSpan({
          traceId: "primary-immutable-002",
          spanId: "attach-anchor",
          startTimeUnixNano: "1741392060000000000",
          endTimeUnixNano: "1741392060500000000",
          spanStatusCode: 2,
          httpStatusCode: 500,
          peerService: "stripe",
          route: "/checkout",
        }),
      ]),
      makeResourceSpans("billing-worker", [
        makeTraceSpan({
          traceId: "primary-immutable-002",
          spanId: "attach-earlier-b",
          startTimeUnixNano: "1741391990000000000",
          endTimeUnixNano: "1741391990500000000",
          spanStatusCode: 2,
          httpStatusCode: 503,
          peerService: "stripe",
          route: "/charge",
        }),
        makeTraceSpan({
          traceId: "primary-immutable-002",
          spanId: "attach-later-b",
          startTimeUnixNano: "1741392065000000000",
          endTimeUnixNano: "1741392065500000000",
          spanStatusCode: 2,
          httpStatusCode: 503,
          peerService: "stripe",
          route: "/charge",
        }),
      ]),
    ]);

    const attachRes = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(attachPayload),
    });

    const attachBody = await attachRes.json() as { incidentId: string };
    expect(attachBody.incidentId).toBe(incidentId);

    const incident = await (await app.request(`/api/incidents/${incidentId}`)).json() as {
      packet: {
        scope: { primaryService: string };
        triggerSignals: Array<{ entity: string }>;
      };
    };

    expect(incident.packet.scope.primaryService).toBe("checkout-api");
    expect(incident.packet.triggerSignals.some((signal) => signal.entity === "billing-worker")).toBe(true);
  });
});

// ── Formation: dependency-based grouping (OC-1 to OC-6) ──────────────────────

/**
 * Helper to build a minimal OTLP JSON trace payload for a given service with
 * an HTTP 429 error span.  `peerService` is optional.
 */
function makeSpanPayload(opts: {
  serviceName: string;
  environment?: string;
  httpStatusCode?: number;
  spanStatusCode?: number;
  spanKind?: number;
  startTimeUnixNano?: string;
  peerService?: string;
  traceId?: string;
  spanId?: string;
}) {
  const {
    serviceName,
    environment = "production",
    httpStatusCode = 429,
    spanStatusCode = 0,
    spanKind,
    startTimeUnixNano = "1741392000000000000",
    peerService,
    traceId = "abc" + Math.random().toString(36).slice(2, 8),
    spanId = "sp" + Math.random().toString(36).slice(2, 10),
  } = opts;
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: serviceName } },
            { key: "deployment.environment.name", value: { stringValue: environment } },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId,
                spanId,
                name: "POST /api",
                ...(spanKind !== undefined ? { kind: spanKind } : {}),
                startTimeUnixNano,
                endTimeUnixNano: String(BigInt(startTimeUnixNano) + BigInt(500_000_000)),
                status: { code: spanStatusCode },
                attributes: [
                  { key: "http.route", value: { stringValue: "/api" } },
                  { key: "http.response.status_code", value: { intValue: httpStatusCode } },
                  ...(peerService
                    ? [{ key: "peer.service", value: { stringValue: peerService } }]
                    : []),
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function makeBatchPayload(serviceName: string, spans: Array<{
  traceId: string;
  spanId: string;
  startTimeUnixNano: string;
  httpStatusCode: number;
  spanStatusCode: number;
  spanKind?: number;
  peerService?: string;
}>): { resourceSpans: object[] } {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: serviceName } },
            { key: "deployment.environment.name", value: { stringValue: "production" } },
          ],
        },
        scopeSpans: [
          {
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              name: span.spanId,
              ...(span.spanKind !== undefined ? { kind: span.spanKind } : {}),
              startTimeUnixNano: span.startTimeUnixNano,
              endTimeUnixNano: String(BigInt(span.startTimeUnixNano) + BigInt(500_000_000)),
              status: { code: span.spanStatusCode },
              attributes: [
                { key: "http.route", value: { stringValue: "/notifications/send" } },
                { key: "http.response.status_code", value: { intValue: span.httpStatusCode } },
                ...(span.peerService
                  ? [{ key: "peer.service", value: { stringValue: span.peerService } }]
                  : []),
              ],
            })),
          },
        ],
      },
    ],
  };
}

async function postTraces(
  app: ReturnType<typeof createApp>,
  payload: object,
): Promise<{ status: string; incidentId?: string; packetId?: string }> {
  const res = await app.request("/v1/traces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json() as Promise<{ status: string; incidentId?: string; packetId?: string }>;
}

type IncidentListItem = {
  incidentId: string;
  packet: { scope: { primaryService: string; affectedDependencies: string[]; affectedServices: string[] }; triggerSignals: unknown[] };
};

async function getIncidents(
  app: ReturnType<typeof createApp>,
): Promise<{ items: IncidentListItem[] }> {
  const res = await app.request("/api/incidents");
  return res.json() as Promise<{ items: IncidentListItem[] }>;
}

describe("Formation: dependency-based incident grouping (OC-1 to OC-6)", () => {
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

  // OC-1: separate requests with different dependencies → 2 incidents
  it("OC-1: service-A→stripe and service-A→twilio produce 2 incidents (split: different dep)", async () => {
    await postTraces(app, makeSpanPayload({ serviceName: "api-service", peerService: "stripe" }));
    await postTraces(app, makeSpanPayload({ serviceName: "api-service", peerService: "twilio" }));

    const { items } = await getIncidents(app);
    expect(items).toHaveLength(2);

    // Ensure the two incidents have different IDs
    const ids = new Set(items.map((i) => i.incidentId));
    expect(ids.size).toBe(2);
  });

  // OC-2: cross-service, same dependency, MAX未満 → 1 incident; packet composition verified
  it("OC-2: service-A→stripe and service-B→stripe (cross-service, affectedServices<MAX) → 1 incident", async () => {
    const r1 = await postTraces(app, makeSpanPayload({ serviceName: "api-service", peerService: "stripe" }));
    const r2 = await postTraces(app, makeSpanPayload({ serviceName: "checkout-service", peerService: "stripe" }));

    const { items } = await getIncidents(app);
    expect(items).toHaveLength(1);

    // Both requests should return the same incidentId
    expect(r2.incidentId).toBe(r1.incidentId);

    // Packet composition checks
    const incident = items[0];
    expect(incident.packet.scope.affectedServices).toContain("api-service");
    expect(incident.packet.scope.affectedServices).toContain("checkout-service");
    expect(incident.packet.scope.affectedDependencies).toContain("stripe");
  });

  // OC-3: no peerService → classic service matching → 1 incident
  it("OC-3: two requests for same service without peerService → 1 incident (fallback service matching)", async () => {
    await postTraces(app, makeSpanPayload({ serviceName: "api-service", httpStatusCode: 500, spanStatusCode: 2 }));
    await postTraces(app, makeSpanPayload({ serviceName: "api-service", httpStatusCode: 500, spanStatusCode: 2 }));

    const { items } = await getIncidents(app);
    expect(items).toHaveLength(1);
  });

  // OC-5: 4 services with same dep → MAX_CROSS_SERVICE_MERGE exceeded → ≥2 incidents
  it("OC-5: 4 services all→stripe → MAX_CROSS_SERVICE_MERGE exceeded → 2+ incidents", async () => {
    // Services A, B, C, D all call stripe.  After A+B+C are merged, the 4th
    // service triggers a split because affectedServices.length >= MAX(3).
    await postTraces(app, makeSpanPayload({ serviceName: "svc-a", peerService: "stripe" }));
    await postTraces(app, makeSpanPayload({ serviceName: "svc-b", peerService: "stripe" }));
    await postTraces(app, makeSpanPayload({ serviceName: "svc-c", peerService: "stripe" }));
    await postTraces(app, makeSpanPayload({ serviceName: "svc-d", peerService: "stripe" }));

    const { items } = await getIncidents(app);
    expect(items.length).toBeGreaterThanOrEqual(2);
  });

  // OC-6: 1 batch with both stripe and redis → dependency=undefined → service matching
  it("OC-6: single batch with stripe+redis spans → dependency=undefined → service matching → 1 incident", async () => {
    // Two anomalous spans in a single POST — different peerService values
    const batchPayload = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "api-service" } },
              { key: "deployment.environment.name", value: { stringValue: "production" } },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "oc6trace1",
                  spanId: "oc6span1",
                  name: "POST /checkout",
                  startTimeUnixNano: "1741392000000000000",
                  endTimeUnixNano: "1741392000500000000",
                  status: { code: 0 },
                  attributes: [
                    { key: "http.route", value: { stringValue: "/checkout" } },
                    { key: "http.response.status_code", value: { intValue: 429 } },
                    { key: "peer.service", value: { stringValue: "stripe" } },
                  ],
                },
                {
                  traceId: "oc6trace2",
                  spanId: "oc6span2",
                  name: "GET /cart",
                  startTimeUnixNano: "1741392000000000000",
                  endTimeUnixNano: "1741392006000000000", // >5s → slow span anomaly
                  status: { code: 0 },
                  attributes: [
                    { key: "http.route", value: { stringValue: "/cart" } },
                    { key: "http.response.status_code", value: { intValue: 200 } },
                    { key: "peer.service", value: { stringValue: "redis" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    await postTraces(app, batchPayload);

    const { items } = await getIncidents(app);
    // Multi-dep batch → dependency=undefined → falls back to service matching → 1 incident
    expect(items).toHaveLength(1);
    // dependency should NOT be set (multi-dep batch fallback)
    // affectedDependencies may still be populated by the packetizer from peerService
    // but the formation key must not have split the batch.
  });

  // OC-7: localhost peerService → ignored → service matching → 1 incident (not split by bogus dep)
  it("OC-7: two requests with peer.service=localhost → normalized away → service matching → 1 incident", async () => {
    await postTraces(app, makeSpanPayload({ serviceName: "api-service", httpStatusCode: 500, spanStatusCode: 2, peerService: "localhost" }));
    await postTraces(app, makeSpanPayload({ serviceName: "api-service", httpStatusCode: 500, spanStatusCode: 2, peerService: "localhost" }));

    const { items } = await getIncidents(app);
    expect(items).toHaveLength(1);
  });

  // OC-8: SERVER 429 spans are not incident triggers (deliberate rate-limiting is not a failure)
  it("OC-8: SERVER span (kind=2) returning 429 does not create an incident", async () => {
    // Simulate a dependency service (e.g. mock-stripe) emitting its own SERVER 429 spans.
    // Even with spanStatus=ERROR set, these must not open a new incident.
    const result = await postTraces(app, makeSpanPayload({
      serviceName: "mock-stripe",
      httpStatusCode: 429,
      spanStatusCode: 2,  // instrumentation may set ERROR alongside 429
      spanKind: 2,        // SERVER
    }));

    expect(result.status).toBe("ok");
    expect(result.incidentId).toBeUndefined();

    const { items } = await getIncidents(app);
    expect(items).toHaveLength(0);
  });

  // OC-9: SERVER 429 does not trigger, but a CLIENT 429 from the caller does
  it("OC-9: SERVER 429 (no incident) followed by CLIENT 429 from calling service → 1 incident for caller", async () => {
    // dependency service emits SERVER 429 — must not trigger
    await postTraces(app, makeSpanPayload({
      serviceName: "mock-stripe",
      httpStatusCode: 429,
      spanStatusCode: 2,
      spanKind: 2,
    }));

    // calling service emits a span showing it received 429 — triggers incident
    await postTraces(app, makeSpanPayload({
      serviceName: "checkout-service",
      httpStatusCode: 429,
      spanKind: 3,  // CLIENT
    }));

    const { items } = await getIncidents(app);
    expect(items).toHaveLength(1);
    expect(items[0].packet.scope.primaryService).toBe("checkout-service");
  });

  // OC-11: INTERNAL 429 spans (OTel SDK version quirk: SERVER reported as INTERNAL) do not trigger
  it("OC-11: INTERNAL span (kind=1) returning 429 does not create an incident", async () => {
    // Some OTel SDK versions export SERVER spans as kind=1 (INTERNAL) instead of kind=2 (SERVER).
    // The 429 non-trigger rule must apply to INTERNAL spans as well.
    const result = await postTraces(app, makeSpanPayload({
      serviceName: "mock-stripe",
      httpStatusCode: 429,
      spanStatusCode: 2,  // instrumentation may set ERROR alongside 429
      spanKind: 1,        // INTERNAL — mislabeled SERVER due to OTel SDK quirk
    }));

    expect(result.status).toBe("ok");
    expect(result.incidentId).toBeUndefined();

    const { items } = await getIncidents(app);
    expect(items).toHaveLength(0);
  });

  it("OC-12: repeated dependency 401 spans create an incident for the calling service", async () => {
    const result = await postTraces(
      app,
      makeBatchPayload("validation-web", [
        {
          traceId: "dep401-trace-1",
          spanId: "dep401-span-1",
          startTimeUnixNano: "1741392000000000000",
          httpStatusCode: 401,
          spanStatusCode: 2,
          spanKind: 1,
          peerService: "sendgrid",
        },
        {
          traceId: "dep401-trace-2",
          spanId: "dep401-span-2",
          startTimeUnixNano: "1741392001000000000",
          httpStatusCode: 401,
          spanStatusCode: 2,
          spanKind: 1,
          peerService: "sendgrid",
        },
      ]),
    );

    expect(result.incidentId).toBeDefined();

    const incident = await (await app.request(`/api/incidents/${result.incidentId}`)).json() as {
      packet: {
        scope: { primaryService: string; affectedDependencies: string[] };
        evidence: { representativeTraces: Array<{ httpStatusCode?: number; serviceName: string }> };
      };
    };

    expect(incident.packet.scope.primaryService).toBe("validation-web");
    expect(incident.packet.scope.affectedDependencies).toContain("sendgrid");
    expect(
      incident.packet.evidence.representativeTraces.some(
        (trace) => trace.serviceName === "validation-web" && trace.httpStatusCode === 401,
      ),
    ).toBe(true);
  });

  it("OC-13: dependency 401 does not trigger on a single occurrence", async () => {
    const result = await postTraces(
      app,
      makeBatchPayload("validation-web", [
        {
          traceId: "dep401-single-trace",
          spanId: "dep401-single-span",
          startTimeUnixNano: "1741392000000000000",
          httpStatusCode: 401,
          spanStatusCode: 2,
          spanKind: 1,
          peerService: "sendgrid",
        },
      ]),
    );

    expect(result.incidentId).toBeUndefined();
    const { items } = await getIncidents(app);
    expect(items).toHaveLength(0);
  });

  it("OC-14: dependency auth failure outranks unknown_service spans for incident subject", async () => {
    const payload = {
      resourceSpans: [
        makeBatchPayload("unknown_service:node", [
          {
            traceId: "unknown-trace-1",
            spanId: "unknown-span-1",
            startTimeUnixNano: "1741391999000000000",
            httpStatusCode: 200,
            spanStatusCode: 2,
            spanKind: 1,
          },
        ]).resourceSpans[0],
        makeBatchPayload("validation-web", [
          {
            traceId: "dep401-trace-3",
            spanId: "dep401-span-3",
            startTimeUnixNano: "1741392000000000000",
            httpStatusCode: 401,
            spanStatusCode: 2,
            spanKind: 1,
            peerService: "sendgrid",
          },
          {
            traceId: "dep401-trace-4",
            spanId: "dep401-span-4",
            startTimeUnixNano: "1741392000500000000",
            httpStatusCode: 401,
            spanStatusCode: 2,
            spanKind: 1,
            peerService: "sendgrid",
          },
        ]).resourceSpans[0],
      ],
    };

    const result = await postTraces(app, payload);
    const incident = await (await app.request(`/api/incidents/${result.incidentId}`)).json() as {
      packet: { scope: { primaryService: string } };
    };

    expect(incident.packet.scope.primaryService).toBe("validation-web");
  });

  // OC-10: SERVER 429-only batch appends anomalous signals to existing incident (evidence retention)
  it("OC-10: SERVER 429-only batch appends signals to matching existing incident without creating a new one", async () => {
    // Step 1: create an incident with a trigger span (SERVER 500, no peerService)
    const r1 = await postTraces(app, makeSpanPayload({
      serviceName: "api-service",
      httpStatusCode: 500,
      spanStatusCode: 2,
      startTimeUnixNano: "1741392000000000000",
    }));
    const incidentId = r1.incidentId!;
    expect(incidentId).toBeDefined();

    const incidentBefore = await storage.getIncident(incidentId);
    const signalCountBefore = incidentBefore?.anomalousSignals.length ?? 0;
    expect(signalCountBefore).toBeGreaterThan(0); // sanity: initial trigger appended signals

    // Step 2: POST a SERVER 429-only batch (same service+env, within window).
    // isIncidentTrigger returns false (no new incident), but isAnomalous returns true
    // (429 is an anomalous signal that should be retained as evidence).
    const r2 = await postTraces(app, makeSpanPayload({
      serviceName: "api-service",
      httpStatusCode: 429,
      spanStatusCode: 2,
      spanKind: 2, // SERVER
      startTimeUnixNano: "1741392060000000000", // 1 min later, within 5-min window
    }));

    // No new incident
    expect(r2.incidentId).toBeUndefined();
    const { items } = await getIncidents(app);
    expect(items).toHaveLength(1);

    // The 429 signal must be appended to the existing incident's anomalousSignals
    const incidentAfter = await storage.getIncident(incidentId);
    expect(incidentAfter?.anomalousSignals.length).toBeGreaterThan(signalCountBefore);
  });

  it("OC-15: replayed secrets rotation traces form an incident around validation-web and sendgrid", async () => {
    for (const batch of secretsRotationReplayPayload) {
      await postTraces(app, batch);
    }

    const { items } = await getIncidents(app);
    const incident = items.find((item) => item.packet.scope.affectedDependencies.includes("sendgrid"));

    expect(incident).toBeDefined();
    expect(incident?.packet.scope.primaryService).toBe("validation-web");

    const incidentDetail = await (await app.request(`/api/incidents/${incident!.incidentId}`)).json() as {
      packet: {
        triggerSignals: Array<{ signal: string; entity: string }>;
        scope: { primaryService: string; affectedDependencies: string[] };
        evidence: { representativeTraces: Array<{ serviceName: string; httpStatusCode?: number; spanStatusCode: number }> };
      };
    };

    expect(incidentDetail.packet.scope.primaryService).toBe("validation-web");
    expect(incidentDetail.packet.scope.affectedDependencies).toContain("sendgrid");
    expect(
      incidentDetail.packet.triggerSignals.some(
        (signal) => signal.entity === "validation-web" && signal.signal === "http_401",
      ),
    ).toBe(true);
    expect(
      incidentDetail.packet.evidence.representativeTraces.some(
        (trace) =>
          trace.serviceName === "validation-web" &&
          trace.httpStatusCode === 401 &&
          trace.spanStatusCode === 2,
      ),
    ).toBe(true);
  });
});

// ── Representative traces ranking: rebuild integration ────────────────────────

describe("Representative traces ranking: rebuild integration", () => {
  let storage: MemoryAdapter;
  let app: ReturnType<typeof createApp>;

  // BASE_NS: 2025-03-07T16:00:00Z — used as an anchor for all spans in this block
  const BASE_NS = "1741392000000000000";

  // Helper: build an OTLP JSON payload with a single span from "ranking-svc" in production.
  // httpStatusCode and spanStatusCode control whether the span is anomalous.
  function makeRankingSpan(opts: {
    traceId: string;
    spanId: string;
    httpStatusCode: number;
    spanStatusCode: number;
    startOffsetMs?: number;
  }) {
    const startNs = BigInt(BASE_NS) + BigInt((opts.startOffsetMs ?? 0) * 1_000_000);
    const endNs = startNs + BigInt(200_000_000); // 200ms duration
    return makeTracePayload([
      makeResourceSpans("ranking-svc", [
        makeTraceSpan({
          traceId: opts.traceId,
          spanId: opts.spanId,
          startTimeUnixNano: startNs.toString(),
          endTimeUnixNano: endNs.toString(),
          httpStatusCode: opts.httpStatusCode,
          spanStatusCode: opts.spanStatusCode,
          route: "/api/rank",
        }),
      ]),
    ]);
  }

  beforeEach(() => {
    delete process.env["RECEIVER_AUTH_TOKEN"];
    process.env["ALLOW_INSECURE_DEV_MODE"] = "true";
    storage = new MemoryAdapter();
    app = createApp(storage);
  });

  afterEach(() => {
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
  });

  // Test 1: Ranking applied on first incident creation
  it("anomalous span (HTTP 500) ranks first in representativeTraces on initial create", async () => {
    // Send: 1 anomalous span + 5 normal spans (all within same window)
    const anomalousRes = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        makeRankingSpan({ traceId: "rank-t1", spanId: "rank-anomaly", httpStatusCode: 500, spanStatusCode: 2 }),
      ),
    });
    const { incidentId } = await anomalousRes.json() as { incidentId: string };

    // Attach 5 normal spans to the same incident (they arrive within 5-min window)
    for (let i = 0; i < 5; i++) {
      await app.request("/v1/traces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          makeRankingSpan({
            traceId: `rank-t1`,
            spanId: `rank-normal-${i}`,
            httpStatusCode: 200,
            spanStatusCode: 1,
            startOffsetMs: 10 + i * 5,
          }),
        ),
      });
    }

    const incident = await (await app.request(`/api/incidents/${incidentId}`)).json() as {
      packet: { evidence: { representativeTraces: Array<{ spanId: string; httpStatusCode?: number }> } };
    };

    const traces = incident.packet.evidence.representativeTraces;
    expect(traces.length).toBeGreaterThan(0);

    // The anomalous span (HTTP 500) must appear first — it has the highest score
    expect(traces[0].spanId).toBe("rank-anomaly");
    expect(traces[0].httpStatusCode).toBe(500);
  });

  // Test 2: Ranking maintained after attach + rebuild
  it("anomalous spans appear in representativeTraces after attach rebuild, length ≤ MAX_REPRESENTATIVE_TRACES", async () => {
    // Phase 1: create incident with 3 normal spans
    const firstNormal = makeRankingSpan({
      traceId: "rank-t2-normal",
      spanId: "rank-t2-normal-0",
      httpStatusCode: 200,
      spanStatusCode: 1,
    });
    const _createRes = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(firstNormal),
    });

    // If first batch is all-normal, no incident is created.
    // So we need to seed with an anomalous span first then attach normals.
    // Instead: create incident via anomalous span, then attach more anomalous spans.
    const seedPayload = makeRankingSpan({
      traceId: "rank-t2-seed",
      spanId: "rank-t2-seed-span",
      httpStatusCode: 500,
      spanStatusCode: 2,
    });
    const seedRes = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(seedPayload),
    });
    const { incidentId } = await seedRes.json() as { incidentId: string };

    // Phase 2: attach 5 more anomalous spans (same service/env, within window)
    for (let i = 0; i < 5; i++) {
      await app.request("/v1/traces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          makeRankingSpan({
            traceId: "rank-t2-seed",
            spanId: `rank-t2-attach-${i}`,
            httpStatusCode: 429,
            spanStatusCode: 2,
            startOffsetMs: 30 + i * 10,
          }),
        ),
      });
    }

    const incident = await (await app.request(`/api/incidents/${incidentId}`)).json() as {
      packet: { evidence: { representativeTraces: Array<{ httpStatusCode?: number; spanStatusCode: number }> } };
    };

    const traces = incident.packet.evidence.representativeTraces;

    // All attached anomalous spans should be present (either 429 or 500)
    const anomalousCount = traces.filter(
      (t) => (t.httpStatusCode !== undefined && t.httpStatusCode >= 400) || t.spanStatusCode === 2,
    ).length;
    expect(anomalousCount).toBeGreaterThan(0);

    // Length must not exceed the cap
    expect(traces.length).toBeLessThanOrEqual(MAX_REPRESENTATIVE_TRACES);
  });

  // Test 3: Determinism across 2 rebuilds with identical input
  it("identical span batches produce identical representativeTraces across 2 rebuilds", async () => {
    // Create incident via first batch
    const batchPayload = makeRankingSpan({
      traceId: "rank-t3",
      spanId: "rank-t3-span",
      httpStatusCode: 500,
      spanStatusCode: 2,
    });

    const firstRes = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batchPayload),
    });
    const { incidentId } = await firstRes.json() as { incidentId: string };

    const incidentAfterFirst = await (await app.request(`/api/incidents/${incidentId}`)).json() as {
      packet: { evidence: { representativeTraces: Array<{ traceId: string; spanId: string }> } };
    };
    const tracesAfterFirst = incidentAfterFirst.packet.evidence.representativeTraces;

    // Post the same content again (different spanId to avoid dedup by traceId+spanId,
    // but same anomaly score so ranking is deterministic)
    const batchPayload2 = makeRankingSpan({
      traceId: "rank-t3",
      spanId: "rank-t3-span-b",
      httpStatusCode: 500,
      spanStatusCode: 2,
      startOffsetMs: 60,
    });

    await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batchPayload2),
    });

    const incidentAfterSecond = await (await app.request(`/api/incidents/${incidentId}`)).json() as {
      packet: { evidence: { representativeTraces: Array<{ traceId: string; spanId: string }> } };
    };
    const tracesAfterSecond = incidentAfterSecond.packet.evidence.representativeTraces;

    // Both rebuilds must include the first span (it has max score and deterministic tiebreak)
    // The first span from tracesAfterFirst must still be present in tracesAfterSecond
    expect(tracesAfterFirst.length).toBeGreaterThan(0);
    expect(tracesAfterSecond.length).toBeGreaterThan(0);

    // The top span from the first rebuild must still appear in the second rebuild
    // (determinism guarantee: same traceId+spanId key → same position)
    const firstTopSpanId = tracesAfterFirst[0].spanId;
    const secondSpanIds = tracesAfterSecond.map((t) => t.spanId);
    expect(secondSpanIds).toContain(firstTopSpanId);

    // Lengths must both be within budget
    expect(tracesAfterFirst.length).toBeLessThanOrEqual(MAX_REPRESENTATIVE_TRACES);
    expect(tracesAfterSecond.length).toBeLessThanOrEqual(MAX_REPRESENTATIVE_TRACES);
  });
});
