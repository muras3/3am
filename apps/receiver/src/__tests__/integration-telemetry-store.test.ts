/**
 * Integration tests for TelemetryStore (ADR 0032 Step 4+5).
 *
 * Covers:
 *  1. Telemetry API endpoints (Evidence Studio DB queries)
 *  2. spanMembership accumulation and cap
 *  3. telemetryScope monotonic expansion
 *  4. createIncident / updatePacket split
 *  5. rebuildSnapshots E2E flow
 *  6. MemoryTelemetryAdapter auto-create (DJ-3)
 *  7. Platform events through new path
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryAdapter } from "../storage/adapters/memory.js";
import { MemoryTelemetryAdapter } from "../telemetry/adapters/memory.js";
import { createApp } from "../index.js";
import { spanMembershipKey, MAX_SPAN_MEMBERSHIP, MAX_ANOMALOUS_SIGNALS } from "../storage/interface.js";
import type { AnomalousSignal } from "../storage/interface.js";

// ── Constants ─────────────────────────────────────────────────────────────────
// Anchored at 2025-03-07T16:00:00Z (same epoch as existing integration tests)
const BASE_TIME_NS = "1741392000000000000"; // epoch ns
const BASE_TIME_MS = 1741392000000; // epoch ms

// ── Payload builders ──────────────────────────────────────────────────────────

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

function makeTraceSpan(options: {
  traceId: string;
  spanId: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  httpStatusCode?: number;
  peerService?: string;
  spanStatusCode: number;
  route?: string;
  parentSpanId?: string;
}): object {
  const attributes: object[] = [];
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
    ...(options.parentSpanId ? { parentSpanId: options.parentSpanId } : {}),
    name: options.route ?? options.spanId,
    startTimeUnixNano: options.startTimeUnixNano,
    endTimeUnixNano: options.endTimeUnixNano,
    status: { code: options.spanStatusCode },
    attributes,
  };
}

function makeTracePayload(resourceSpans: object[]) {
  return { resourceSpans };
}

function makeMetricsPayload(
  serviceName: string,
  metricName: string,
  timeNano: string,
  value: number,
  environment = "production",
) {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: serviceName } },
            {
              key: "deployment.environment.name",
              value: { stringValue: environment },
            },
          ],
        },
        scopeMetrics: [
          {
            metrics: [
              {
                name: metricName,
                gauge: {
                  dataPoints: [
                    {
                      startTimeUnixNano: timeNano,
                      timeUnixNano: timeNano,
                      asDouble: value,
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

function makeLogsPayload(
  serviceName: string,
  body: string,
  timeNano: string,
  severity: { text: string; number: number },
  traceId?: string,
  spanId?: string,
  environment = "production",
) {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: serviceName } },
            {
              key: "deployment.environment.name",
              value: { stringValue: environment },
            },
          ],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: timeNano,
                severityNumber: severity.number,
                severityText: severity.text,
                body: { stringValue: body },
                attributes: [],
                ...(traceId ? { traceId } : {}),
                ...(spanId ? { spanId } : {}),
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Helper: POST JSON to a route and return parsed body. */
async function postJson(
  app: ReturnType<typeof createApp>,
  path: string,
  payload: object,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

/** Helper: GET a route and return parsed body. */
async function getJson(
  app: ReturnType<typeof createApp>,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const res = await app.request(path);
  const body = await res.json();
  return { status: res.status, body };
}

/** Ingest an error span and return the created incidentId. */
async function ingestErrorSpan(
  app: ReturnType<typeof createApp>,
  opts: {
    traceId: string;
    spanId: string;
    startTimeNs?: string;
    endTimeNs?: string;
    serviceName?: string;
    peerService?: string;
    route?: string;
    httpStatusCode?: number;
  },
): Promise<string> {
  const startTimeNs = opts.startTimeNs ?? BASE_TIME_NS;
  const endTimeNs =
    opts.endTimeNs ?? String(BigInt(startTimeNs) + BigInt(500_000_000));
  const payload = makeTracePayload([
    makeResourceSpans(opts.serviceName ?? "web", [
      makeTraceSpan({
        traceId: opts.traceId,
        spanId: opts.spanId,
        startTimeUnixNano: startTimeNs,
        endTimeUnixNano: endTimeNs,
        httpStatusCode: opts.httpStatusCode ?? 500,
        spanStatusCode: 2,
        peerService: opts.peerService,
        route: opts.route ?? "/checkout",
      }),
    ]),
  ]);
  const { body } = await postJson(app, "/v1/traces", payload);
  return body.incidentId as string;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("TelemetryStore integration tests (ADR 0032 Step 4+5)", () => {
  let storage: MemoryAdapter;
  let telemetryStore: MemoryTelemetryAdapter;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    delete process.env["RECEIVER_AUTH_TOKEN"];
    process.env["ALLOW_INSECURE_DEV_MODE"] = "true";
    storage = new MemoryAdapter();
    telemetryStore = new MemoryTelemetryAdapter();
    app = createApp(storage, { telemetryStore });
  });

  afterEach(() => {
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. Telemetry API endpoints (Evidence Studio -> DB)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("GET /api/incidents/:id/telemetry/spans", () => {
    it("returns only incident-bound spans (spanMembership filtering)", async () => {
      // Ingest error span (creates incident + spanMembership entry)
      const incidentId = await ingestErrorSpan(app, {
        traceId: "aaaa1111aaaa1111aaaa1111aaaa1111",
        spanId: "bbbb2222bbbb2222",
        serviceName: "web",
      });

      // Ingest a NORMAL span from same service/env/time that won't be in membership
      // (normal spans are ingested to TelemetryStore but won't be in spanMembership
      // unless they're part of an incident batch)
      const normalPayload = makeTracePayload([
        makeResourceSpans("web", [
          makeTraceSpan({
            traceId: "cccc3333cccc3333cccc3333cccc3333",
            spanId: "dddd4444dddd4444",
            startTimeUnixNano: BASE_TIME_NS,
            endTimeUnixNano: String(BigInt(BASE_TIME_NS) + BigInt(100_000_000)),
            spanStatusCode: 1,
            httpStatusCode: 200,
            route: "/health",
          }),
        ]),
      ]);
      await postJson(app, "/v1/traces", normalPayload);

      // Query telemetry spans endpoint
      const { status, body } = await getJson(
        app,
        `/api/incidents/${incidentId}/telemetry/spans`,
      );
      expect(status).toBe(200);

      const spans = body as Array<{ traceId: string; spanId: string }>;
      // Should only contain the incident-bound span, not the normal one
      expect(spans.length).toBeGreaterThanOrEqual(1);
      const spanKeys = spans.map((s) => spanMembershipKey(s.traceId, s.spanId));
      expect(
        spanKeys.includes(
          spanMembershipKey(
            "aaaa1111aaaa1111aaaa1111aaaa1111",
            "bbbb2222bbbb2222",
          ),
        ),
      ).toBe(true);
      // The normal span should NOT be in the result
      expect(
        spanKeys.includes(
          spanMembershipKey(
            "cccc3333cccc3333cccc3333cccc3333",
            "dddd4444dddd4444",
          ),
        ),
      ).toBe(false);
    });

    it("returns 404 for non-existent incident", async () => {
      const { status } = await getJson(
        app,
        "/api/incidents/inc_nonexistent/telemetry/spans",
      );
      expect(status).toBe(404);
    });
  });

  describe("GET /api/incidents/:id/telemetry/metrics", () => {
    it("returns metrics matching the incident telemetryScope", async () => {
      // Create incident
      const incidentId = await ingestErrorSpan(app, {
        traceId: "aaaa1111aaaa1111aaaa1111aaaa1111",
        spanId: "bbbb2222bbbb2222",
        serviceName: "web",
      });

      // Ingest metrics within the incident's time window and service
      const metricsPayload = makeMetricsPayload(
        "web",
        "http.server.request.error_rate",
        BASE_TIME_NS,
        0.85,
      );
      await postJson(app, "/v1/metrics", metricsPayload);

      const { status, body } = await getJson(
        app,
        `/api/incidents/${incidentId}/telemetry/metrics`,
      );
      expect(status).toBe(200);

      const metrics = body as Array<{ name: string; service: string }>;
      expect(metrics.length).toBeGreaterThan(0);
      expect(metrics.some((m) => m.name === "http.server.request.error_rate")).toBe(true);
    });

    it("returns 404 for non-existent incident", async () => {
      const { status } = await getJson(
        app,
        "/api/incidents/inc_nonexistent/telemetry/metrics",
      );
      expect(status).toBe(404);
    });
  });

  describe("GET /api/incidents/:id/telemetry/logs", () => {
    it("splits logs into correlated and contextual based on traceId", async () => {
      const traceId = "aaaa1111aaaa1111aaaa1111aaaa1111";
      const spanId = "bbbb2222bbbb2222";

      // Create incident with a known traceId
      const incidentId = await ingestErrorSpan(app, {
        traceId,
        spanId,
        serviceName: "web",
      });

      // Ingest a log WITH the same traceId (should be correlated)
      const correlatedLog = makeLogsPayload(
        "web",
        "checkout failed: connection refused",
        BASE_TIME_NS,
        { text: "ERROR", number: 17 },
        traceId,
        spanId,
      );
      await postJson(app, "/v1/logs", correlatedLog);

      // Ingest a log WITHOUT traceId (should be contextual)
      const contextualLog = makeLogsPayload(
        "web",
        "general warning: high memory usage",
        BASE_TIME_NS,
        { text: "WARN", number: 13 },
      );
      await postJson(app, "/v1/logs", contextualLog);

      const { status, body } = await getJson(
        app,
        `/api/incidents/${incidentId}/telemetry/logs`,
      );
      expect(status).toBe(200);

      const result = body as {
        correlated: Array<{ body: string; traceId?: string }>;
        contextual: Array<{ body: string; traceId?: string }>;
      };

      expect(result.correlated.length).toBeGreaterThanOrEqual(1);
      expect(result.contextual.length).toBeGreaterThanOrEqual(1);

      // Correlated logs should have traceIds matching incident spans
      for (const log of result.correlated) {
        expect(log.traceId).toBe(traceId);
      }

      // Contextual logs should not have matching traceId
      for (const log of result.contextual) {
        expect(log.traceId).toBeUndefined();
      }
    });

    it("returns { correlated: [], contextual: [] } for non-existent incident", async () => {
      const { status } = await getJson(
        app,
        "/api/incidents/inc_nonexistent/telemetry/logs",
      );
      expect(status).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. spanMembership accumulation and cap
  // ═══════════════════════════════════════════════════════════════════════════

  describe("spanMembership accumulation and cap", () => {
    it("accumulates span membership across trace batches", async () => {
      // First batch: create incident
      const incidentId = await ingestErrorSpan(app, {
        traceId: "trace_batch1_00000000000000000000",
        spanId: "span_batch1_0001",
        serviceName: "web",
        peerService: "stripe",
      });

      // Second batch: same incident (same service/env/dep within formation window)
      const secondBatch = makeTracePayload([
        makeResourceSpans("web", [
          makeTraceSpan({
            traceId: "trace_batch2_00000000000000000000",
            spanId: "span_batch2_0001",
            // Within 5-min formation window
            startTimeUnixNano: String(
              BigInt(BASE_TIME_NS) + BigInt(60_000_000_000),
            ),
            endTimeUnixNano: String(
              BigInt(BASE_TIME_NS) + BigInt(60_500_000_000),
            ),
            httpStatusCode: 500,
            spanStatusCode: 2,
            peerService: "stripe",
            route: "/checkout",
          }),
        ]),
      ]);
      const { body } = await postJson(app, "/v1/traces", secondBatch);
      expect(body.incidentId).toBe(incidentId);

      // Verify both spans are in membership
      const incident = (await storage.getIncident(incidentId))!;
      expect(incident.spanMembership).toContain(
        spanMembershipKey(
          "trace_batch1_00000000000000000000",
          "span_batch1_0001",
        ),
      );
      expect(incident.spanMembership).toContain(
        spanMembershipKey(
          "trace_batch2_00000000000000000000",
          "span_batch2_0001",
        ),
      );
    });

    it("enforces MAX_SPAN_MEMBERSHIP cap", async () => {
      // Create incident
      const incidentId = await ingestErrorSpan(app, {
        traceId: "trace_cap_test_0000000000000000000",
        spanId: "span_cap_test_001",
        serviceName: "web",
      });

      // Directly append synthetic span IDs beyond the cap to test enforcement
      const syntheticIds: string[] = [];
      for (let i = 0; i < MAX_SPAN_MEMBERSHIP + 100; i++) {
        syntheticIds.push(
          spanMembershipKey(
            `t${i.toString().padStart(10, "0")}`,
            `s${i.toString().padStart(10, "0")}`,
          ),
        );
      }
      await storage.appendSpanMembership(incidentId, syntheticIds);

      const incident = (await storage.getIncident(incidentId))!;
      expect(incident.spanMembership.length).toBeLessThanOrEqual(
        MAX_SPAN_MEMBERSHIP,
      );
    });

    it("enforces MAX_ANOMALOUS_SIGNALS cap (B-12)", async () => {
      const incidentId = await ingestErrorSpan(app, {
        traceId: "trace_sigcap_00000000000000000000",
        spanId: "span_sigcap_001",
        serviceName: "web",
      });

      // Directly append synthetic signals beyond the cap
      const signals: AnomalousSignal[] = Array.from(
        { length: MAX_ANOMALOUS_SIGNALS + 100 },
        (_, i) => ({
          signal: `sig_${i}`,
          firstSeenAt: new Date(Date.now() + i * 1000).toISOString(),
          entity: "web",
          spanId: `span_gen_${i}`,
        }),
      );
      await storage.appendAnomalousSignals(incidentId, signals);

      const incident2 = (await storage.getIncident(incidentId))!;
      expect(incident2.anomalousSignals.length).toBeLessThanOrEqual(
        MAX_ANOMALOUS_SIGNALS,
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. telemetryScope monotonic expansion
  // ═══════════════════════════════════════════════════════════════════════════

  describe("telemetryScope monotonic expansion", () => {
    it("initial telemetryScope matches first span batch window", async () => {
      const startNs = BASE_TIME_NS; // 1741392000000000000
      const endNs = String(BigInt(startNs) + BigInt(500_000_000)); // +500ms
      const incidentId = await ingestErrorSpan(app, {
        traceId: "scope_init_00000000000000000000",
        spanId: "scope_init_span01",
        serviceName: "web",
        startTimeNs: startNs,
        endTimeNs: endNs,
      });

      const incident = (await storage.getIncident(incidentId))!;
      const { telemetryScope } = incident;

      // windowStartMs should be the span startTime
      expect(telemetryScope.windowStartMs).toBe(BASE_TIME_MS);
      // windowEndMs should be startTimeMs + durationMs
      expect(telemetryScope.windowEndMs).toBe(BASE_TIME_MS + 500);
      expect(telemetryScope.environment).toBe("production");
      expect(telemetryScope.memberServices).toContain("web");
    });

    it("expands scope when new spans have wider window", async () => {
      const incidentId = await ingestErrorSpan(app, {
        traceId: "scope_expand_001_00000000000000000",
        spanId: "scope_exp_span01",
        serviceName: "web",
        peerService: "stripe",
      });

      const beforeIncident = (await storage.getIncident(incidentId))!;
      const beforeScope = beforeIncident.telemetryScope;

      // Second batch with EARLIER start and LATER end
      const earlierStartNs = String(
        BigInt(BASE_TIME_NS) - BigInt(10_000_000_000),
      ); // 10s before
      const laterEndNs = String(
        BigInt(BASE_TIME_NS) + BigInt(60_500_000_000),
      ); // 60.5s after base
      const secondPayload = makeTracePayload([
        makeResourceSpans("checkout-api", [
          makeTraceSpan({
            traceId: "scope_expand_002_00000000000000000",
            spanId: "scope_exp_span02",
            startTimeUnixNano: earlierStartNs,
            endTimeUnixNano: laterEndNs,
            httpStatusCode: 500,
            spanStatusCode: 2,
            peerService: "stripe",
            route: "/charge",
          }),
        ]),
      ]);
      const { body } = await postJson(app, "/v1/traces", secondPayload);
      expect(body.incidentId).toBe(incidentId);

      const afterIncident = (await storage.getIncident(incidentId))!;
      const afterScope = afterIncident.telemetryScope;

      // windowStartMs should decrease (monotonic expansion)
      expect(afterScope.windowStartMs).toBeLessThanOrEqual(
        beforeScope.windowStartMs,
      );
      // windowEndMs should increase (monotonic expansion)
      expect(afterScope.windowEndMs).toBeGreaterThanOrEqual(
        beforeScope.windowEndMs,
      );

      // memberServices should accumulate
      expect(afterScope.memberServices).toContain("web");
      expect(afterScope.memberServices).toContain("checkout-api");

      // dependencyServices should accumulate
      expect(afterScope.dependencyServices).toContain("stripe");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. createIncident / updatePacket split
  // ═══════════════════════════════════════════════════════════════════════════

  describe("createIncident / updatePacket split", () => {
    it("createIncident saves compact fields alongside packet", async () => {
      const incidentId = await ingestErrorSpan(app, {
        traceId: "split_test_001_00000000000000000000",
        spanId: "split_span_00001",
        serviceName: "web",
        peerService: "stripe",
      });

      const incident = (await storage.getIncident(incidentId))!;

      // Compact fields should be populated
      expect(incident.telemetryScope.windowStartMs).toBe(BASE_TIME_MS);
      expect(incident.telemetryScope.windowEndMs).toBeGreaterThan(BASE_TIME_MS);
      expect(incident.telemetryScope.environment).toBe("production");
      expect(incident.spanMembership.length).toBeGreaterThanOrEqual(1);
      expect(incident.anomalousSignals.length).toBeGreaterThanOrEqual(1);
      expect(incident.platformEvents).toEqual([]);
    });

    it("updatePacket preserves compact fields", async () => {
      const incidentId = await ingestErrorSpan(app, {
        traceId: "update_pkt_001_00000000000000000000",
        spanId: "update_pkt_span01",
        serviceName: "web",
      });

      // Record compact fields before any updatePacket
      const before = (await storage.getIncident(incidentId))!;
      const scopeBefore = { ...before.telemetryScope };
      const membershipBefore = [...before.spanMembership];
      const signalsBefore = [...before.anomalousSignals];

      // Ingest metrics (marks incident as stale via touchIncidentActivity)
      const metricsPayload = makeMetricsPayload(
        "web",
        "http.server.request.error_rate",
        BASE_TIME_NS,
        0.95,
      );
      await postJson(app, "/v1/metrics", metricsPayload);

      // On-read materialization: GET triggers snapshot rebuild (which calls updatePacket)
      await app.request(`/api/incidents/${incidentId}/packet`);

      // Verify compact fields are preserved
      const after = (await storage.getIncident(incidentId))!;
      expect(after.telemetryScope.windowStartMs).toBe(
        scopeBefore.windowStartMs,
      );
      expect(after.telemetryScope.windowEndMs).toBe(scopeBefore.windowEndMs);
      expect(after.telemetryScope.environment).toBe(scopeBefore.environment);
      // spanMembership should be at least what it was before
      for (const ref of membershipBefore) {
        expect(after.spanMembership).toContain(ref);
      }
      // anomalousSignals should be preserved
      expect(after.anomalousSignals.length).toBeGreaterThanOrEqual(
        signalsBefore.length,
      );

      // But the packet should have been updated (generation incremented)
      expect(after.packet.generation).toBeGreaterThan(before.packet.generation ?? 1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. rebuildSnapshots E2E flow
  // ═══════════════════════════════════════════════════════════════════════════

  describe("rebuildSnapshots E2E flow", () => {
    it("builds packet.evidence.representativeTraces from spanMembership-filtered spans", async () => {
      // Ingest error span → creates incident + TelemetryStore has spans
      const incidentId = await ingestErrorSpan(app, {
        traceId: "rebuild_trace_001_0000000000000000",
        spanId: "rebuild_span_0001",
        serviceName: "web",
        route: "/checkout",
        httpStatusCode: 500,
      });

      // Get the incident and verify representativeTraces
      const incident = (await storage.getIncident(incidentId))!;
      const repTraces = incident.packet.evidence.representativeTraces;
      expect(repTraces.length).toBeGreaterThanOrEqual(1);

      // The representative trace should be from the spanMembership-filtered set
      const memberKeys = new Set(incident.spanMembership);
      for (const trace of repTraces) {
        const key = spanMembershipKey(trace.traceId, trace.spanId);
        expect(memberKeys.has(key)).toBe(true);
      }
    });

    it("packet.scope.affectedServices comes from memberServices", async () => {
      // Create incident with web service
      const incidentId = await ingestErrorSpan(app, {
        traceId: "affected_svc_001_0000000000000000",
        spanId: "affected_svc_sp01",
        serviceName: "web",
        peerService: "stripe",
      });

      // Attach second service to same incident
      const secondBatch = makeTracePayload([
        makeResourceSpans("checkout-api", [
          makeTraceSpan({
            traceId: "affected_svc_002_0000000000000000",
            spanId: "affected_svc_sp02",
            startTimeUnixNano: String(
              BigInt(BASE_TIME_NS) + BigInt(30_000_000_000),
            ),
            endTimeUnixNano: String(
              BigInt(BASE_TIME_NS) + BigInt(30_500_000_000),
            ),
            httpStatusCode: 500,
            spanStatusCode: 2,
            peerService: "stripe",
            route: "/charge",
          }),
        ]),
      ]);
      const { body } = await postJson(app, "/v1/traces", secondBatch);
      expect(body.incidentId).toBe(incidentId);

      // On-read materialization: GET /api/incidents/:id/packet triggers snapshot rebuild
      const pktRes = await app.request(`/api/incidents/${incidentId}/packet`);
      const packet = await pktRes.json() as { scope: { affectedServices: string[] } };

      // affectedServices should come from memberServices, not all services
      expect(packet.scope.affectedServices).toContain("web");
      expect(packet.scope.affectedServices).toContain("checkout-api");

      // Verify memberServices in telemetryScope matches
      const incident = (await storage.getIncident(incidentId))!;
      expect(incident.telemetryScope.memberServices).toContain("web");
      expect(incident.telemetryScope.memberServices).toContain("checkout-api");
    });

    it("packet.evidence.changedMetrics populated after metrics ingest + rebuildSnapshots", async () => {
      const incidentId = await ingestErrorSpan(app, {
        traceId: "metrics_rebuild_001_000000000000000",
        spanId: "metrics_rebld_sp01",
        serviceName: "web",
      });

      // Ingest metrics within the incident scope
      const metricsPayload = makeMetricsPayload(
        "web",
        "http.server.request.error_rate",
        BASE_TIME_NS,
        0.95,
      );
      await postJson(app, "/v1/metrics", metricsPayload);

      // On-read materialization: GET triggers snapshot rebuild
      const packetRes = await app.request(`/api/incidents/${incidentId}/packet`);
      const packet = await packetRes.json() as { evidence: { changedMetrics: unknown[] } };
      expect(packet.evidence.changedMetrics.length).toBeGreaterThan(0);
    });

    it("packet.evidence.relevantLogs populated after logs ingest + rebuildSnapshots", async () => {
      const incidentId = await ingestErrorSpan(app, {
        traceId: "logs_rebuild_001_00000000000000000",
        spanId: "logs_rebuild_sp01",
        serviceName: "web",
      });

      const logsPayload = makeLogsPayload(
        "web",
        "connection refused to stripe",
        BASE_TIME_NS,
        { text: "ERROR", number: 17 },
      );
      await postJson(app, "/v1/logs", logsPayload);

      // On-read materialization: GET triggers snapshot rebuild
      const packetRes = await app.request(`/api/incidents/${incidentId}/packet`);
      const packet = await packetRes.json() as { evidence: { relevantLogs: unknown[] } };
      expect(packet.evidence.relevantLogs.length).toBeGreaterThan(0);
    });

    it("snapshots are stored in TelemetryStore after rebuild", async () => {
      const incidentId = await ingestErrorSpan(app, {
        traceId: "snapshot_check_001_000000000000000",
        spanId: "snapshot_chk_sp01",
        serviceName: "web",
      });

      // Trigger on-read materialization via API — this rebuilds snapshots
      await app.request(`/api/incidents/${incidentId}/packet`);

      // Check that snapshots were created in TelemetryStore
      const snapshots = await telemetryStore.getSnapshots(incidentId);
      // At minimum, a traces snapshot should exist after materialization
      const traceSnapshot = snapshots.find((s) => s.snapshotType === "traces");
      expect(traceSnapshot).toBeDefined();
      expect(Array.isArray(traceSnapshot!.data)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. MemoryTelemetryAdapter auto-create (DJ-3)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("MemoryTelemetryAdapter auto-create (DJ-3)", () => {
    it("app works without explicit telemetryStore (auto-creates MemoryTelemetryAdapter)", async () => {
      // Create app without telemetryStore option
      const autoApp = createApp(new MemoryAdapter());

      // Should not crash — ingest and query work
      const tracePayload = makeTracePayload([
        makeResourceSpans("web", [
          makeTraceSpan({
            traceId: "auto_create_001_00000000000000000",
            spanId: "auto_create_sp01",
            startTimeUnixNano: BASE_TIME_NS,
            endTimeUnixNano: String(
              BigInt(BASE_TIME_NS) + BigInt(500_000_000),
            ),
            httpStatusCode: 500,
            spanStatusCode: 2,
            route: "/checkout",
          }),
        ]),
      ]);

      const { status, body } = await postJson(
        autoApp,
        "/v1/traces",
        tracePayload,
      );
      expect(status).toBe(200);
      expect(body.incidentId).toBeDefined();

      const incidentId = body.incidentId as string;

      // Telemetry query endpoints should work
      const spansRes = await getJson(
        autoApp,
        `/api/incidents/${incidentId}/telemetry/spans`,
      );
      expect(spansRes.status).toBe(200);
      const spans = spansRes.body as unknown[];
      expect(spans.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. Platform events through new path
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Platform events through new path", () => {
    it("platform events are stored on incident.platformEvents", async () => {
      const incidentId = await ingestErrorSpan(app, {
        traceId: "platform_evt_001_00000000000000000",
        spanId: "platform_evt_sp01",
        serviceName: "web",
      });

      const event = {
        eventType: "deploy",
        timestamp: new Date(BASE_TIME_MS + 250).toISOString(),
        environment: "production",
        description: "web rollout v2",
        service: "web",
        deploymentId: "dep_456",
        releaseVersion: "2025.03.07.2",
        details: { initiatedBy: "ci" },
      };

      const { status } = await postJson(app, "/v1/platform-events", {
        events: [event],
      });
      expect(status).toBe(200);

      const incident = (await storage.getIncident(incidentId))!;
      expect(incident.platformEvents.length).toBe(1);
      expect(incident.platformEvents[0]!.eventType).toBe("deploy");
    });

    it("rebuildSnapshots includes platformEvents in packet.evidence", async () => {
      const incidentId = await ingestErrorSpan(app, {
        traceId: "platform_pkt_001_00000000000000000",
        spanId: "platform_pkt_sp01",
        serviceName: "web",
      });

      const event = {
        eventType: "config_change",
        timestamp: new Date(BASE_TIME_MS + 100).toISOString(),
        environment: "production",
        description: "env var update",
        service: "web",
      };

      await postJson(app, "/v1/platform-events", { events: [event] });

      // On-read materialization: GET /api/incidents/:id/packet triggers snapshot rebuild
      const pktRes = await app.request(`/api/incidents/${incidentId}/packet`);
      const packet = await pktRes.json() as {
        evidence: { platformEvents: Array<{ eventType: string }> };
        pointers: { platformLogRefs: unknown[] };
      };
      expect(packet.evidence.platformEvents.length).toBe(1);
      expect(packet.evidence.platformEvents[0]!.eventType).toBe(
        "config_change",
      );

      // platformLogRefs should also be populated
      expect(
        packet.pointers.platformLogRefs.length,
      ).toBeGreaterThanOrEqual(1);
    });
  });
});
