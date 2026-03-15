/**
 * Packet-Rebuild Gate Tests (ADR 0030)
 *
 * Gate 1: packetId stability across rebuilds
 * Gate 2: raw state is the single source of truth (SSOT)
 * Gate 3: diagnosis path still works after rebuild (needs ANTHROPIC_API_KEY)
 * Gate 4: regression — existing integration behaviour unchanged
 * Gate 5: performance — rebuild completes within time budget
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { performance } from "node:perf_hooks";
import { MemoryAdapter } from "../storage/adapters/memory.js";
import { createApp } from "../index.js";
import { rebuildPacket, buildAnomalousSignals } from "../domain/packetizer.js";
import { isAnomalous } from "../domain/anomaly-detector.js";
import type { ExtractedSpan } from "../domain/anomaly-detector.js";
import type { IncidentRawState } from "../storage/interface.js";
import type { ChangedMetric, IncidentPacket, RelevantLog } from "@3amoncall/core";

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
                name: "http.server.request.duration",
                histogram: {
                  dataPoints: [
                    {
                      startTimeUnixNano: BASE_TIME_NS,
                      timeUnixNano: BASE_TIME_NS,
                      count: "10",
                      sum: 500.0,
                      min: 1.0,
                      max: 99.0,
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

  it("thin event's packet_id matches the stable packetId", async () => {
    const { app, storage } = setupApp();

    const res1 = await postTraces(app, makeErrorBatch1());
    const { packetId } = (await res1.json()) as { packetId: string };

    // Attach second batch
    await postTraces(app, makeErrorBatch2());

    const events = await storage.listThinEvents();
    expect(events).toHaveLength(1);
    expect(events[0].packet_id).toBe(packetId);
  });
});

// ── Gate 2: SSOT — raw state drives rebuild ───────────────────────────────────

describe("Gate 2: SSOT — raw state drives rebuild", () => {
  afterEach(() => {
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
  });

  it("rawState.spans accumulates across batches", async () => {
    const { app, storage } = setupApp();

    const res1 = await postTraces(app, makeErrorBatch1());
    const { incidentId } = (await res1.json()) as { incidentId: string };

    // Batch 1 contributed 1 span
    const stateAfterBatch1 = await storage.getRawState(incidentId);
    expect(stateAfterBatch1).not.toBeNull();
    const spanCountAfterBatch1 = stateAfterBatch1!.spans.length;
    expect(spanCountAfterBatch1).toBeGreaterThanOrEqual(1);

    // Second batch — attaches, appends more spans
    await postTraces(app, makeErrorBatch2());

    const stateAfterBatch2 = await storage.getRawState(incidentId);
    expect(stateAfterBatch2).not.toBeNull();
    // Span count must be greater than after batch 1
    expect(stateAfterBatch2!.spans.length).toBeGreaterThan(spanCountAfterBatch1);
  });

  it("triggerSignals reflect all batches — both http_500 and span_error appear", async () => {
    const { app } = setupApp();

    const res1 = await postTraces(app, makeErrorBatch1());
    const { incidentId, packetId } = (await res1.json()) as { incidentId: string; packetId: string };

    // Attach second batch (span_error signal, no httpStatusCode)
    await postTraces(app, makeErrorBatch2());

    const pktRes = await app.request(`/api/packets/${packetId}`);
    const pkt = (await pktRes.json()) as IncidentPacket;

    const signalTypes = pkt.triggerSignals.map((s) => s.signal);
    expect(signalTypes).toContain("http_500");
    expect(signalTypes).toContain("span_error");
    expect(incidentId).toBeTruthy(); // identity check
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

  it("rebuild is idempotent — same rawState produces same packet structure", () => {
    const rawState: IncidentRawState = {
      spans: [
        {
          traceId: "t1",
          spanId: "s1",
          serviceName: "web",
          environment: "production",
          httpRoute: "/checkout",
          httpStatusCode: 500,
          spanStatusCode: 2,
          durationMs: 500,
          startTimeMs: 1741392000000,
          peerService: undefined,
          exceptionCount: 0,
        },
      ],
      anomalousSignals: [
        {
          signal: "http_500",
          firstSeenAt: new Date(1741392000000).toISOString(),
          entity: "web",
          spanId: "s1",
        },
      ],
      metricEvidence: [],
      logEvidence: [],
      platformEvents: [],
    };

    const p1 = rebuildPacket("inc_test", "pkt_stable", new Date(1741392000000).toISOString(), rawState);
    const p2 = rebuildPacket("inc_test", "pkt_stable", new Date(1741392000000).toISOString(), rawState);

    expect(p1.triggerSignals).toEqual(p2.triggerSignals);
    expect(p1.scope.affectedServices).toEqual(p2.scope.affectedServices);
    expect(p1.window.start).toBe(p2.window.start);
    expect(p1.window.end).toBe(p2.window.end);
    expect(p1.packetId).toBe(p2.packetId);
  });

  it("metrics evidence flows through rawState and rebuilds packet (Plan 6)", async () => {
    const { app, storage } = setupApp();

    const res1 = await postTraces(app, makeErrorBatch1());
    const { incidentId } = (await res1.json()) as { incidentId: string };

    // Post metrics — now goes to rawState + rebuild
    await app.request("/v1/metrics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeMetricsBatch()),
    });

    // rawState.metricEvidence should be populated (Plan 6 migration)
    const rawState = await storage.getRawState(incidentId);
    expect(rawState).not.toBeNull();
    expect(rawState!.metricEvidence.length).toBeGreaterThan(0);

    // packet.evidence.changedMetrics should be derived from rawState via rebuild
    const incident = (await (await app.request(`/api/incidents/${incidentId}`)).json()) as {
      packet: { evidence: { changedMetrics: unknown[] }; pointers: { metricRefs: string[] } };
    };
    expect(incident.packet.evidence.changedMetrics.length).toBeGreaterThan(0);
    // B-5: pointers.metricRefs should also be populated
    expect(incident.packet.pointers.metricRefs.length).toBeGreaterThan(0);
  });
});

// ── Gate 3: Diagnosis path (skipped without ANTHROPIC_API_KEY) ─────────────────

describe("Gate 3: Diagnosis path", () => {
  afterEach(() => {
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
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
      const { diagnose } = await dynamicImport("@3amoncall/diagnosis") as {
        diagnose: (packet: IncidentPacket) => Promise<{
          summary: { root_cause_hypothesis: string };
          recommendation: { immediate_action: string };
          metadata: { packet_id: string; incident_id: string };
        }>;
      };
      const { app, storage } = setupApp();

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

      // Verify storage still accessible
      const stateAfter = storage.getRawState(incidentId);
      expect(stateAfter).not.toBeNull();
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
    storage = new MemoryAdapter();
    app = createApp(storage);
  });

  afterEach(() => {
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
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
  });

  it("thin event is saved to storage on incident creation", async () => {
    const res = await postTraces(app, makeErrorBatch1());
    const { incidentId } = (await res.json()) as { incidentId: string };

    const events = await storage.listThinEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("incident.created");
    expect(events[0].incident_id).toBe(incidentId);
  });

  it("POST /api/diagnosis/:id saves diagnosisResult and GET returns it", async () => {
    const res = await postTraces(app, makeErrorBatch1());
    const { incidentId } = (await res.json()) as { incidentId: string };

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
      diagnosisResult?: { summary: { what_happened: string } };
    };
    expect(incident.diagnosisResult?.summary.what_happened).toBe("Test incident.");
  });

  it("POST /v1/metrics evidence attaches to matching incident", async () => {
    const res = await postTraces(app, makeErrorBatch1());
    const { incidentId } = (await res.json()) as { incidentId: string };

    await app.request("/v1/metrics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeMetricsBatch()),
    });

    const incident = (await (await app.request(`/api/incidents/${incidentId}`)).json()) as {
      packet: { evidence: { changedMetrics: unknown[] } };
    };
    expect(incident.packet.evidence.changedMetrics.length).toBeGreaterThan(0);
  });

  it("WARN/ERROR/FATAL logs attach; INFO logs are excluded", async () => {
    const res = await postTraces(app, makeErrorBatch1());
    const { incidentId } = (await res.json()) as { incidentId: string };

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

    const incident = (await (await app.request(`/api/incidents/${incidentId}`)).json()) as {
      packet: { evidence: { relevantLogs: unknown[] } };
    };
    // Only the ERROR log should be attached
    expect(incident.packet.evidence.relevantLogs).toHaveLength(1);
  });

  it("evidence from a non-matching service is ignored", async () => {
    const res = await postTraces(app, makeErrorBatch1());
    const { incidentId } = (await res.json()) as { incidentId: string };

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

    const incident = (await (await app.request(`/api/incidents/${incidentId}`)).json()) as {
      packet: { evidence: { changedMetrics: unknown[] } };
    };
    expect(incident.packet.evidence.changedMetrics).toHaveLength(0);
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

  it("Console routes (/api/incidents) are accessible without Bearer token", async () => {
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
    process.env["RECEIVER_AUTH_TOKEN"] = "secret-gate4";
    const securedApp = createApp(new MemoryAdapter());

    const res = await securedApp.request("/api/incidents");
    expect(res.status).toBe(200);

    delete process.env["RECEIVER_AUTH_TOKEN"];
  });
});

// ── Gate 5: Performance — rebuild under time budget ───────────────────────────

describe("Gate 5: Performance — rebuild under time budget", () => {
  afterEach(() => {
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
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

  it("rebuildPacket with 500-span rawState completes within 500ms (Gate 5 spec)", () => {
    // Build a 500-span raw state directly without ingest overhead
    const spans: ExtractedSpan[] = Array.from({ length: 500 }, (_, i) => ({
      traceId: `trace${i.toString().padStart(4, "0")}`,
      spanId: `span${i.toString().padStart(4, "0")}`,
      serviceName: `service-${i % 5}`,
      environment: "production",
      httpStatusCode: i % 10 === 0 ? 500 : 200,
      spanStatusCode: i % 10 === 0 ? 2 : 1,
      durationMs: i % 20 === 0 ? 6000 : 100,
      startTimeMs: 1741392000000 + i * 1000,
      exceptionCount: 0,
    }));

    const rawState: IncidentRawState = {
      spans,
      anomalousSignals: buildAnomalousSignals(spans.filter(isAnomalous)),
      metricEvidence: [],
      logEvidence: [],
      platformEvents: [],
    };

    const t = performance.now();
    rebuildPacket("inc_perf", "pkt_perf", "2025-03-07T16:00:00.000Z", rawState);
    const elapsedMs = performance.now() - t;

    expect(elapsedMs).toBeLessThan(500);
  });
});

// ── Plan 6 / B-4 + B-5: rawState-derived evidence and pointers ────────────────

/** Minimal valid span for constructing rawState (needed so window/scope don't fail) */
function makeMinimalSpan(overrides?: Partial<ExtractedSpan>): ExtractedSpan {
  return {
    traceId: "trace-plan6",
    spanId: "span-plan6",
    serviceName: "web",
    environment: "production",
    httpRoute: "/api/test",
    httpStatusCode: 500,
    spanStatusCode: 2,
    durationMs: 500,
    startTimeMs: 1741392000000,
    peerService: undefined,
    exceptionCount: 0,
    ...overrides,
  };
}

/** Build a minimal IncidentRawState with the given overrides */
function makeRawStateWithEvidence(
  opts: {
    metricEvidence?: ChangedMetric[];
    logEvidence?: RelevantLog[];
  } = {},
): IncidentRawState {
  const span = makeMinimalSpan();
  return {
    spans: [span],
    anomalousSignals: buildAnomalousSignals([span]),
    metricEvidence: opts.metricEvidence ?? [],
    logEvidence: opts.logEvidence ?? [],
    platformEvents: [],
  };
}

function makeSampleMetric(name: string, service = "web"): ChangedMetric {
  return {
    name,
    service,
    environment: "production",
    startTimeMs: 1741392000000,
    summary: { count: 10, sum: 500, min: 1, max: 99 },
  };
}

function makeSampleLog(service = "web", timestamp = "2025-03-07T16:00:00.000Z"): RelevantLog {
  return {
    service,
    environment: "production",
    timestamp,
    startTimeMs: 1741392000000,
    severity: "ERROR",
    body: "checkout failed",
    attributes: {},
  };
}

describe("rebuildPacket — rawState-derived evidence (Plan 6)", () => {
  it("derives changedMetrics from rawState.metricEvidence", () => {
    const metric = makeSampleMetric("http.server.request.duration");
    const rawState = makeRawStateWithEvidence({ metricEvidence: [metric] });

    const packet = rebuildPacket("inc_test", "pkt_test", "2025-03-07T16:00:00.000Z", rawState);

    expect(packet.evidence.changedMetrics).toHaveLength(1);
    expect(packet.evidence.changedMetrics[0]).toEqual(metric);
  });

  it("derives relevantLogs from rawState.logEvidence", () => {
    const log = makeSampleLog();
    const rawState = makeRawStateWithEvidence({ logEvidence: [log] });

    const packet = rebuildPacket("inc_test", "pkt_test", "2025-03-07T16:00:00.000Z", rawState);

    expect(packet.evidence.relevantLogs).toHaveLength(1);
    expect(packet.evidence.relevantLogs[0]).toEqual(log);
  });

  it("populates pointers.metricRefs with unique metric names", () => {
    // Two metrics with the same name should produce only one ref
    const m1 = makeSampleMetric("http.server.request.duration", "web");
    const m2 = makeSampleMetric("http.server.request.duration", "api");  // duplicate name
    const m3 = makeSampleMetric("db.query.duration", "web");
    const rawState = makeRawStateWithEvidence({ metricEvidence: [m1, m2, m3] });

    const packet = rebuildPacket("inc_test", "pkt_test", "2025-03-07T16:00:00.000Z", rawState);

    expect(packet.pointers.metricRefs).toEqual(
      expect.arrayContaining(["http.server.request.duration", "db.query.duration"]),
    );
    expect(packet.pointers.metricRefs).toHaveLength(2);  // duplicates deduped
  });

  it("populates pointers.logRefs with unique service:timestamp keys", () => {
    const t1 = "2025-03-07T16:00:00.000Z";
    const t2 = "2025-03-07T16:01:00.000Z";
    const l1 = makeSampleLog("web", t1);
    const l2 = makeSampleLog("web", t1);   // duplicate key
    const l3 = makeSampleLog("web", t2);   // different timestamp
    const l4 = makeSampleLog("api", t1);   // different service
    const rawState = makeRawStateWithEvidence({ logEvidence: [l1, l2, l3, l4] });

    const packet = rebuildPacket("inc_test", "pkt_test", "2025-03-07T16:00:00.000Z", rawState);

    expect(packet.pointers.logRefs).toHaveLength(3);  // l1/l2 deduped → web:t1, web:t2, api:t1
    expect(packet.pointers.logRefs).toEqual(
      expect.arrayContaining([`web:${t1}`, `web:${t2}`, `api:${t1}`]),
    );
  });

  it("ignores existingEvidence parameter — rawState is sole source", () => {
    const rawState = makeRawStateWithEvidence({
      metricEvidence: [makeSampleMetric("http.server.request.duration")],
      logEvidence: [makeSampleLog()],
    });

    // Pass stale existingEvidence as the deprecated 5th argument
    const staleEvidence = {
      changedMetrics: [{ name: "stale.metric", service: "stale", environment: "staging", startTimeMs: 0, summary: {} }],
      relevantLogs: [{ service: "stale", environment: "staging", timestamp: "2000-01-01T00:00:00.000Z", startTimeMs: 0, severity: "WARN", body: "stale log", attributes: {} }],
    };

    const packet = rebuildPacket("inc_test", "pkt_test", "2025-03-07T16:00:00.000Z", rawState, staleEvidence);

    // Stale data must NOT appear
    const metricNames = packet.evidence.changedMetrics.map((m) => m.name);
    expect(metricNames).not.toContain("stale.metric");
    expect(metricNames).toContain("http.server.request.duration");

    const logBodies = packet.evidence.relevantLogs.map((l) => l.body);
    expect(logBodies).not.toContain("stale log");
    expect(logBodies).toContain("checkout failed");
  });

  it("empty rawState evidence produces empty arrays in packet and pointers", () => {
    const rawState = makeRawStateWithEvidence();  // no metric/log evidence

    const packet = rebuildPacket("inc_test", "pkt_test", "2025-03-07T16:00:00.000Z", rawState);

    expect(packet.evidence.changedMetrics).toEqual([]);
    expect(packet.evidence.relevantLogs).toEqual([]);
    expect(packet.pointers.metricRefs).toEqual([]);
    expect(packet.pointers.logRefs).toEqual([]);
  });
});
