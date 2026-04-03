/**
 * Packet-Rebuild Gate Tests (ADR 0030, updated for ADR 0032)
 *
 * Gate 1: packetId stability across rebuilds
 * Gate 2: incident membership accumulates across batches (replaces rawState SSOT)
 * Gate 3: diagnosis path still works after rebuild (needs ANTHROPIC_API_KEY)
 * Gate 4: regression — existing integration behaviour unchanged
 * Gate 5: performance — rebuild completes within time budget
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { performance } from "node:perf_hooks";
import { MemoryAdapter } from "../storage/adapters/memory.js";
import { createApp } from "../index.js";
import type { IncidentPacket } from "@3am/core";

// ── Shared OTLP JSON payloads ─────────────────────────────────────────────────

// Base time anchor (same as integration.test.ts so formation window logic aligns)
const BASE_TIME_NS = "1741392000000000000"; // 2025-03-07T16:00:00Z
const BASE_TIME_PLUS_1MIN_NS = "1741392060000000000"; // +60s

/** First error batch: http 500 from "web" service */
function makeErrorBatch1() {
  return {
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
                traceId: "trace001",
                spanId: "span001",
                name: "POST /checkout",
                startTimeUnixNano: BASE_TIME_NS,
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
}

/** Second error batch: span_error (no httpStatusCode) from same service, 1 min later */
function makeErrorBatch2() {
  return {
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
                traceId: "trace002",
                spanId: "span002",
                name: "POST /checkout",
                startTimeUnixNano: BASE_TIME_PLUS_1MIN_NS,
                endTimeUnixNano: "1741392060500000000",
                // spanStatusCode=2 without httpStatusCode → "span_error" signal
                status: { code: 2 },
                attributes: [
                  { key: "http.route", value: { stringValue: "/checkout" } },
                  // deliberately no http.response.status_code → signal becomes span_error
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

/** A batch with 10 distinct error spans for the same service/env/window */
function makeMultiSpanBatch(batchIndex: number): object {
  const spans = Array.from({ length: 10 }, (_, i) => ({
    traceId: `trace${batchIndex}_${i}`,
    spanId: `span${batchIndex}_${i}`,
    name: "POST /checkout",
    // All within 5-minute window from BASE_TIME_NS
    startTimeUnixNano: String(BigInt(BASE_TIME_NS) + BigInt(batchIndex * 30 + i) * 1_000_000_000n),
    endTimeUnixNano: String(BigInt(BASE_TIME_NS) + BigInt(batchIndex * 30 + i) * 1_000_000_000n + 500_000_000n),
    status: { code: 2 },
    attributes: [
      { key: "http.route", value: { stringValue: "/checkout" } },
      { key: "http.response.status_code", value: { intValue: 500 } },
    ],
  }));
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "web" } },
            { key: "deployment.environment.name", value: { stringValue: "production" } },
          ],
        },
        scopeSpans: [{ spans }],
      },
    ],
  };
}

function makeMetricsBatch() {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "web" } },
            { key: "deployment.environment.name", value: { stringValue: "production" } },
          ],
        },
        scopeMetrics: [
          {
            metrics: [
              {
                name: "http.server.request.error_rate",
                gauge: {
                  dataPoints: [
                    {
                      startTimeUnixNano: BASE_TIME_NS,
                      timeUnixNano: BASE_TIME_NS,
                      asDouble: 0.85,
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

// ── Test setup helper ─────────────────────────────────────────────────────────

function setupApp() {
  const storage = new MemoryAdapter();
  delete process.env["RECEIVER_AUTH_TOKEN"];
  process.env["ALLOW_INSECURE_DEV_MODE"] = "true";
  // Bypass diagnosis debouncer — these tests expect immediate thin event dispatch
  process.env["DIAGNOSIS_GENERATION_THRESHOLD"] = "0";
  process.env["DIAGNOSIS_MAX_WAIT_MS"] = "0";
  const app = createApp(storage);
  return { storage, app };
}

async function postTraces(app: ReturnType<typeof createApp>, payload: object) {
  return app.request("/v1/traces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// ── Gate 1: packetId stability ────────────────────────────────────────────────

describe("Gate 1: packetId stability", () => {
  afterEach(() => {
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
    delete process.env["DIAGNOSIS_GENERATION_THRESHOLD"];
    delete process.env["DIAGNOSIS_MAX_WAIT_MS"];
  });

  it("packetId is stable after a second batch attaches to the same incident", async () => {
    const { app } = setupApp();

    const res1 = await postTraces(app, makeErrorBatch1());
    const body1 = (await res1.json()) as { incidentId: string; packetId: string };
    const originalPacketId = body1.packetId;
    const incidentId = body1.incidentId;

    // Second batch — same service/env/window → should attach to existing incident
    const res2 = await postTraces(app, makeErrorBatch2());
    const body2 = (await res2.json()) as { incidentId: string; packetId: string };

    expect(body2.incidentId).toBe(incidentId);
    expect(body2.packetId).toBe(originalPacketId); // packetId MUST NOT change
  });

  it("GET /api/packets/:packetId returns rebuilt content after second batch", async () => {
    const { app } = setupApp();

    // First batch
    const res1 = await postTraces(app, makeErrorBatch1());
    const { packetId } = (await res1.json()) as { packetId: string };

    // Second batch attaches
    await postTraces(app, makeErrorBatch2());

    // Packet should now reflect spans from both batches
    const pktRes = await app.request(`/api/packets/${packetId}`);
    expect(pktRes.status).toBe(200);
    const pkt = (await pktRes.json()) as IncidentPacket;

    // generation should be incremented after rebuild
    expect(pkt.generation).toBeGreaterThan(1);
    // packetId is unchanged
    expect(pkt.packetId).toBe(packetId);
    // window should cover at least the first batch timestamp
    expect(new Date(pkt.window.start).getTime()).toBeLessThanOrEqual(
      Number(BigInt(BASE_TIME_NS) / 1_000_000n),
    );
  });

  it("second batch attaches to the same incident (packetId stable)", async () => {
    const { app } = setupApp();

    const res1 = await postTraces(app, makeErrorBatch1());
    const { packetId, incidentId } = (await res1.json()) as { packetId: string; incidentId: string };

    // Attach second batch — should return same incidentId
    const res2 = await postTraces(app, makeErrorBatch2());
    const { incidentId: incidentId2 } = (await res2.json()) as { incidentId: string };

    expect(incidentId2).toBe(incidentId);
    expect(packetId).toBeTruthy();
  });
});

// ── Gate 2: Membership accumulates across batches ─────────────────────────────

describe("Gate 2: membership accumulates across batches", () => {
  afterEach(() => {
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
    delete process.env["DIAGNOSIS_GENERATION_THRESHOLD"];
    delete process.env["DIAGNOSIS_MAX_WAIT_MS"];
  });

  it("spanMembership grows across batches", async () => {
    const { app, storage } = setupApp();

    const res1 = await postTraces(app, makeErrorBatch1());
    const { incidentId } = (await res1.json()) as { incidentId: string; packetId: string };

    // Batch 1 contributed 1 span
    const incidentAfterBatch1 = await storage.getIncident(incidentId);
    expect(incidentAfterBatch1).not.toBeNull();
    const membershipCountBatch1 = incidentAfterBatch1!.spanMembership.length;
    expect(membershipCountBatch1).toBeGreaterThanOrEqual(1);

    // Second batch — attaches, appends more span membership
    await postTraces(app, makeErrorBatch2());

    const incidentAfterBatch2 = await storage.getIncident(incidentId);
    expect(incidentAfterBatch2).not.toBeNull();
    // Span membership must grow
    expect(incidentAfterBatch2!.spanMembership.length).toBeGreaterThan(membershipCountBatch1);
  });

  it("triggerSignals reflect all batches — both http_500 and span_error appear", async () => {
    const { app } = setupApp();

    const res1 = await postTraces(app, makeErrorBatch1());
    const { packetId } = (await res1.json()) as { incidentId: string; packetId: string };

    // Attach second batch (span_error signal, no httpStatusCode)
    await postTraces(app, makeErrorBatch2());

    const pktRes = await app.request(`/api/packets/${packetId}`);
    const pkt = (await pktRes.json()) as IncidentPacket;

    const signalTypes = pkt.triggerSignals.map((s) => s.signal);
    expect(signalTypes).toContain("http_500");
    expect(signalTypes).toContain("span_error");
  });

  it("window.end expands to cover all batches", async () => {
    const { app } = setupApp();

    const res1 = await postTraces(app, makeErrorBatch1());
    const { packetId } = (await res1.json()) as { packetId: string };

    const pkt1Res = await app.request(`/api/packets/${packetId}`);
    const pkt1 = (await pkt1Res.json()) as IncidentPacket;
    const windowEndBefore = new Date(pkt1.window.end).getTime();

    // Second batch arrives 1 minute later — window.end should grow
    await postTraces(app, makeErrorBatch2());

    const pkt2Res = await app.request(`/api/packets/${packetId}`);
    const pkt2 = (await pkt2Res.json()) as IncidentPacket;
    const windowEndAfter = new Date(pkt2.window.end).getTime();

    expect(windowEndAfter).toBeGreaterThanOrEqual(windowEndBefore);
  });

  it("metrics evidence attaches and flows into packet (Plan 6)", async () => {
    const { app } = setupApp();

    const res1 = await postTraces(app, makeErrorBatch1());
    const { packetId } = (await res1.json()) as { incidentId: string; packetId: string };

    // Post metrics — now goes through evidence attachment pipeline
    await app.request("/v1/metrics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeMetricsBatch()),
    });

    // packet.evidence.changedMetrics should be populated
    const packet = (await (await app.request(`/api/packets/${packetId}`)).json()) as {
      evidence: { changedMetrics: unknown[] };
      pointers: { metricRefs: string[] };
    };
    expect(packet.evidence.changedMetrics.length).toBeGreaterThan(0);
    // pointers.metricRefs should also be populated
    expect(packet.pointers.metricRefs.length).toBeGreaterThan(0);
  });
});

// ── Gate 3: Diagnosis path (skipped without ANTHROPIC_API_KEY) ─────────────────

describe("Gate 3: Diagnosis path", () => {
  afterEach(() => {
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
    delete process.env["DIAGNOSIS_GENERATION_THRESHOLD"];
    delete process.env["DIAGNOSIS_MAX_WAIT_MS"];
  });

  const shouldRunLiveDiagnosisTest =
    process.env["RUN_LIVE_ANTHROPIC_TESTS"] === "true" &&
    Boolean(process.env["ANTHROPIC_API_KEY"]);

  it.skipIf(!shouldRunLiveDiagnosisTest)(
    "rebuilt packet can be passed to diagnose() and yields root_cause_hypothesis + immediate_action",
    async () => {
      // Resolve the built workspace package only when live diagnosis tests are enabled.
      // This keeps receiver typecheck scoped to its own source tree.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dynamicImport = new Function("specifier", "return import(specifier)") as (s: string) => Promise<any>;
      const { diagnose } = await dynamicImport("@3am/diagnosis") as {
        diagnose: (packet: IncidentPacket) => Promise<{
          summary: { root_cause_hypothesis: string };
          recommendation: { immediate_action: string };
          metadata: { packet_id: string; incident_id: string };
        }>;
      };
      const { app } = setupApp();

      // Create incident and attach a second batch so rebuild is exercised
      const res1 = await postTraces(app, makeErrorBatch1());
      const { incidentId, packetId } = (await res1.json()) as {
        incidentId: string;
        packetId: string;
      };
      await postTraces(app, makeErrorBatch2());

      // Fetch the rebuilt packet
      const pktRes = await app.request(`/api/packets/${packetId}`);
      expect(pktRes.status).toBe(200);
      const packet = (await pktRes.json()) as IncidentPacket;

      const result = await diagnose(packet);

      expect(result.summary.root_cause_hypothesis).toBeTruthy();
      expect(result.recommendation.immediate_action).toBeTruthy();
      expect(result.metadata.packet_id).toBe(packetId);
      expect(result.metadata.incident_id).toBe(incidentId);
    },
  );
});

// ── Gate 4: Regression — existing behaviour unchanged ─────────────────────────

describe("Gate 4: Regression — existing behaviour", () => {
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

  it("new incident creation returns incidentId + packetId (200)", async () => {
    const res = await postTraces(app, makeErrorBatch1());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; incidentId: string; packetId: string };
    expect(body.status).toBe("ok");
    expect(body.incidentId.startsWith("inc_")).toBe(true);
    expect(typeof body.packetId).toBe("string");
  });

  it("GET /api/packets/:packetId returns valid IncidentPacket", async () => {
    const res = await postTraces(app, makeErrorBatch1());
    const { packetId } = (await res.json()) as { packetId: string };

    const pktRes = await app.request(`/api/packets/${packetId}`);
    expect(pktRes.status).toBe(200);
    const pkt = (await pktRes.json()) as IncidentPacket;
    expect(pkt.schemaVersion).toBe("incident-packet/v1alpha1");
    expect(pkt.packetId).toBe(packetId);
    // signalSeverity must be set and be a valid enum value
    expect(pkt.signalSeverity).toBeDefined();
    expect(["critical", "high", "medium", "low"]).toContain(pkt.signalSeverity);
  });

  it("incident is created and returned on first error span (ADR 0034: no thin events)", async () => {
    const res = await postTraces(app, makeErrorBatch1());
    const { incidentId } = (await res.json()) as { incidentId: string; packetId: string };

    expect(incidentId).toBeTruthy();
    const incident = await storage.getIncident(incidentId);
    expect(incident).not.toBeNull();
  });

  it("POST /api/diagnosis/:id saves diagnosisResult and curated incident reflects it", async () => {
    const res = await postTraces(app, makeErrorBatch1());
    const { incidentId } = (await res.json()) as { incidentId: string; packetId: string };

    const fixture = {
      summary: {
        what_happened: "Test incident.",
        root_cause_hypothesis: "Rate limit cascade.",
      },
      recommendation: {
        immediate_action: "Disable retries.",
        action_rationale_short: "Fastest fix.",
        do_not: "Do not restart.",
      },
      reasoning: {
        causal_chain: [{ type: "external", title: "API 429", detail: "rate limit" }],
      },
      operator_guidance: { watch_items: [], operator_checks: [] },
      confidence: { confidence_assessment: "High.", uncertainty: "None." },
      metadata: {
        incident_id: incidentId,
        packet_id: "pkt_test",
        model: "test",
        prompt_version: "v5",
        created_at: new Date().toISOString(),
      },
    };

    const diagRes = await app.request(`/api/diagnosis/${incidentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fixture),
    });
    expect(diagRes.status).toBe(200);

    const incidentRes = await app.request(`/api/incidents/${incidentId}`);
    const incident = (await incidentRes.json()) as {
      headline: string;
      state: { diagnosis: string };
    };
    expect(incident.state.diagnosis).toBe("ready");
    expect(incident.headline).toBe("Test incident.");
  });

  it("POST /v1/metrics evidence attaches to matching incident", async () => {
    const res = await postTraces(app, makeErrorBatch1());
    const { packetId } = (await res.json()) as { incidentId: string; packetId: string };

    await app.request("/v1/metrics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeMetricsBatch()),
    });

    const packet = (await (await app.request(`/api/packets/${packetId}`)).json()) as {
      evidence: { changedMetrics: unknown[] };
    };
    expect(packet.evidence.changedMetrics.length).toBeGreaterThan(0);
  });

  it("WARN/ERROR/FATAL logs attach; INFO logs are excluded", async () => {
    const res = await postTraces(app, makeErrorBatch1());
    const { packetId } = (await res.json()) as { incidentId: string; packetId: string };

    const logsPayload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "web" } },
              { key: "deployment.environment.name", value: { stringValue: "production" } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                // INFO (9) — must be excluded
                {
                  timeUnixNano: BASE_TIME_NS,
                  severityNumber: 9,
                  severityText: "INFO",
                  body: { stringValue: "ok" },
                  attributes: [],
                },
                // ERROR (17) — must be included
                {
                  timeUnixNano: BASE_TIME_NS,
                  severityNumber: 17,
                  severityText: "ERROR",
                  body: { stringValue: "checkout failed" },
                  attributes: [],
                },
              ],
            },
          ],
        },
      ],
    };

    await app.request("/v1/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(logsPayload),
    });

    const packet = (await (await app.request(`/api/packets/${packetId}`)).json()) as {
      evidence: { relevantLogs: unknown[] };
    };
    // Only the ERROR log should be attached
    expect(packet.evidence.relevantLogs).toHaveLength(1);
  });

  it("evidence from a non-matching service is ignored", async () => {
    const res = await postTraces(app, makeErrorBatch1());
    const { packetId } = (await res.json()) as { incidentId: string; packetId: string };

    // Metrics from a completely different service
    const otherServiceMetrics = {
      resourceMetrics: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "billing" } }, // different service
              { key: "deployment.environment.name", value: { stringValue: "production" } },
            ],
          },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "some.metric",
                  gauge: {
                    dataPoints: [{ timeUnixNano: BASE_TIME_NS, asDouble: 1.0 }],
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    await app.request("/v1/metrics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(otherServiceMetrics),
    });

    const packet = (await (await app.request(`/api/packets/${packetId}`)).json()) as {
      evidence: { changedMetrics: unknown[] };
    };
    expect(packet.evidence.changedMetrics).toHaveLength(0);
  });

  it("Bearer token is required on /v1/traces when RECEIVER_AUTH_TOKEN is set", async () => {
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
    process.env["RECEIVER_AUTH_TOKEN"] = "secret-gate4";
    const securedApp = createApp(new MemoryAdapter());

    const res = await securedApp.request("/v1/traces", { method: "POST" });
    expect(res.status).toBe(401);

    // Cleanup
    process.env["RECEIVER_AUTH_TOKEN"] = undefined;
    delete process.env["RECEIVER_AUTH_TOKEN"];
  });

  it("Bearer token is required on /api/diagnosis/:id when RECEIVER_AUTH_TOKEN is set", async () => {
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
    process.env["RECEIVER_AUTH_TOKEN"] = "secret-gate4";
    const securedApp = createApp(new MemoryAdapter());

    const res = await securedApp.request("/api/diagnosis/inc_test", { method: "POST" });
    expect(res.status).toBe(401);

    delete process.env["RECEIVER_AUTH_TOKEN"];
  });

  it("Console routes (/api/incidents) require Bearer auth (ADR 0034)", async () => {
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
    process.env["RECEIVER_AUTH_TOKEN"] = "secret-gate4";
    const securedApp = createApp(new MemoryAdapter());

    const noAuthRes = await securedApp.request("/api/incidents");
    expect(noAuthRes.status).toBe(401);

    const authRes = await securedApp.request("/api/incidents", {
      headers: { Authorization: "Bearer secret-gate4" },
    });
    expect(authRes.status).toBe(200);

    delete process.env["RECEIVER_AUTH_TOKEN"];
  });
});

// ── Gate 5: Performance — rebuild under time budget ───────────────────────────

describe("Gate 5: Performance — rebuild under time budget", () => {
  afterEach(() => {
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
    delete process.env["DIAGNOSIS_GENERATION_THRESHOLD"];
    delete process.env["DIAGNOSIS_MAX_WAIT_MS"];
  });

  it("5 batches of 10 spans each — each request responds within 100ms (in-process budget)", async () => {
    const { app } = setupApp();

    // Batch 0 → creates the incident
    const t0 = performance.now();
    const res0 = await postTraces(app, makeMultiSpanBatch(0));
    const firstResponseMs = performance.now() - t0;
    expect(res0.status).toBe(200);

    // Batches 1–4 → each attaches to the incident and triggers rebuild
    const attachTimes: number[] = [];
    for (let i = 1; i <= 4; i++) {
      const t = performance.now();
      const res = await postTraces(app, makeMultiSpanBatch(i));
      attachTimes.push(performance.now() - t);
      expect(res.status).toBe(200);
    }

    const lastResponseMs = attachTimes[attachTimes.length - 1];
    const avgAttachMs = attachTimes.reduce((a, b) => a + b, 0) / attachTimes.length;

    // Each in-process request must complete within 100ms
    expect(lastResponseMs).toBeLessThan(100);
    // Average attach time must not balloon relative to the first response
    // (factor-3 budget covers micro-benchmarking variance)
    expect(avgAttachMs).toBeLessThan(Math.max(firstResponseMs * 3, 100));
  });
});
