/**
 * Shared StorageDriver contract test suite.
 *
 * Import and call `runStorageSuite` in each adapter's test file.
 * This ensures all adapters satisfy the same behavioural contract.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { StorageDriver, AnomalousSignal } from "../../storage/interface.js";
import type { ExtractedSpan } from "../../domain/anomaly-detector.js";
import type { IncidentPacket, DiagnosisResult, PlatformEvent, ThinEvent } from "@3amoncall/core";

// ── Fixtures ──────────────────────────────────────────────────────────────────

export function makePacket(overrides: Partial<IncidentPacket> = {}): IncidentPacket {
  return {
    schemaVersion: "incident-packet/v1alpha1",
    packetId: "pkt_test_001",
    incidentId: "inc_test_001",
    openedAt: "2026-03-09T03:00:00Z",
    status: "open",
    window: {
      start: "2026-03-09T02:55:00Z",
      detect: "2026-03-09T03:00:00Z",
      end: "2026-03-09T03:05:00Z",
    },
    scope: {
      environment: "production",
      primaryService: "web",
      affectedServices: ["web"],
      affectedRoutes: ["/checkout"],
      affectedDependencies: ["stripe"],
    },
    triggerSignals: [{ signal: "http_429", firstSeenAt: "2026-03-09T03:00:00Z", entity: "stripe" }],
    evidence: {
      changedMetrics: [],
      representativeTraces: [],
      relevantLogs: [],
      platformEvents: [],
    },
    pointers: { traceRefs: ["trace_abc"], logRefs: [], metricRefs: [], platformLogRefs: [] },
    ...overrides,
  };
}

export function makeDiagnosis(incidentId: string, packetId: string): DiagnosisResult {
  return {
    summary: { what_happened: "Rate limit cascade.", root_cause_hypothesis: "Stripe 429." },
    recommendation: {
      immediate_action: "Disable retry loop.",
      action_rationale_short: "Stops cascade.",
      do_not: "Do not increase timeout.",
    },
    reasoning: {
      causal_chain: [{ type: "external", title: "Stripe 429", detail: "Rate limited." }],
    },
    operator_guidance: { watch_items: [], operator_checks: ["Check Stripe dashboard."] },
    confidence: { confidence_assessment: "High", uncertainty: "Unknown reset time." },
    metadata: {
      incident_id: incidentId,
      packet_id: packetId,
      model: "claude-haiku-4-5-20251001",
      prompt_version: "v5",
      created_at: "2026-03-09T03:10:00Z",
    },
  };
}

export function makeThinEvent(overrides: Partial<ThinEvent> = {}): ThinEvent {
  return {
    event_id: "evt_test_001",
    event_type: "incident.created",
    incident_id: "inc_test_001",
    packet_id: "pkt_test_001",
    ...overrides,
  };
}

export function makeSpan(id: string, overrides: Partial<ExtractedSpan> = {}): ExtractedSpan {
  return {
    traceId: "trace_test",
    spanId: id,
    serviceName: "web",
    environment: "production",
    spanStatusCode: 0,
    durationMs: 100,
    startTimeMs: 1000,
    exceptionCount: 0,
    ...overrides,
  };
}

// ── Shared suite ──────────────────────────────────────────────────────────────

export function runStorageSuite(
  name: string,
  getDriver: () => StorageDriver,
  opts?: { cleanup?: () => Promise<void> },
): void {
  describe(`StorageDriver contract — ${name}`, () => {
    let driver: StorageDriver;

    beforeEach(async () => {
      // Optional cleanup (e.g. TRUNCATE for Postgres) runs before each test
      if (opts?.cleanup) await opts.cleanup();
      driver = getDriver();
    });

    // createIncident ─────────────────────────────────────────────────────────

    it("createIncident stores an incident retrievable by getIncident", async () => {
      const packet = makePacket();
      await driver.createIncident(packet);
      const incident = await driver.getIncident(packet.incidentId);
      expect(incident).not.toBeNull();
      expect(incident?.incidentId).toBe(packet.incidentId);
      expect(incident?.status).toBe("open");
      expect(incident?.openedAt).toBe(packet.openedAt);
    });

    it("createIncident upserts: re-inserting updates packet but preserves diagnosisResult", async () => {
      const packet = makePacket();
      await driver.createIncident(packet);
      const dr = makeDiagnosis(packet.incidentId, packet.packetId);
      await driver.appendDiagnosis(packet.incidentId, dr);

      // Re-insert with a different packet (e.g. more evidence)
      const updatedPacket = makePacket({ packetId: "pkt_test_001_v2" });
      await driver.createIncident(updatedPacket);

      const incident = await driver.getIncident(packet.incidentId);
      // packet must be updated and diagnosisResult must be preserved across upsert
      expect(incident?.packet.packetId).toBe("pkt_test_001_v2");
      expect(incident?.diagnosisResult?.summary.what_happened).toBe("Rate limit cascade.");
    });

    // getIncidentByPacketId ──────────────────────────────────────────────────

    it("getIncidentByPacketId returns incident matching the packetId", async () => {
      const packet = makePacket();
      await driver.createIncident(packet);
      const found = await driver.getIncidentByPacketId(packet.packetId);
      expect(found?.incidentId).toBe(packet.incidentId);
    });

    it("getIncidentByPacketId returns null for unknown packetId", async () => {
      expect(await driver.getIncidentByPacketId("pkt_unknown")).toBeNull();
    });

    // getIncident ────────────────────────────────────────────────────────────

    it("getIncident returns null for unknown incidentId", async () => {
      expect(await driver.getIncident("inc_unknown")).toBeNull();
    });

    // updateIncidentStatus ───────────────────────────────────────────────────

    it("updateIncidentStatus changes status to closed and sets closedAt", async () => {
      const packet = makePacket();
      await driver.createIncident(packet);
      await driver.updateIncidentStatus(packet.incidentId, "closed");

      const incident = await driver.getIncident(packet.incidentId);
      expect(incident?.status).toBe("closed");
      expect(incident?.closedAt).toBeDefined();
    });

    it("updateIncidentStatus is a no-op for unknown incidentId", async () => {
      // Should not throw
      await expect(driver.updateIncidentStatus("inc_unknown", "closed")).resolves.toBeUndefined();
    });

    // appendDiagnosis ────────────────────────────────────────────────────────

    it("appendDiagnosis is a no-op for unknown incidentId", async () => {
      const dr = makeDiagnosis("inc_unknown", "pkt_unknown");
      await expect(driver.appendDiagnosis("inc_unknown", dr)).resolves.toBeUndefined();
    });

    it("appendDiagnosis attaches diagnosisResult to incident", async () => {
      const packet = makePacket();
      await driver.createIncident(packet);
      const dr = makeDiagnosis(packet.incidentId, packet.packetId);
      await driver.appendDiagnosis(packet.incidentId, dr);

      const incident = await driver.getIncident(packet.incidentId);
      expect(incident?.diagnosisResult?.summary.root_cause_hypothesis).toBe("Stripe 429.");
    });

    // listIncidents ──────────────────────────────────────────────────────────

    it("listIncidents returns incidents ordered by openedAt desc", async () => {
      const p1 = makePacket({ incidentId: "inc_a", packetId: "pkt_a", openedAt: "2026-03-09T01:00:00Z" });
      const p2 = makePacket({ incidentId: "inc_b", packetId: "pkt_b", openedAt: "2026-03-09T03:00:00Z" });
      const p3 = makePacket({ incidentId: "inc_c", packetId: "pkt_c", openedAt: "2026-03-09T02:00:00Z" });
      await driver.createIncident(p1);
      await driver.createIncident(p2);
      await driver.createIncident(p3);

      const page = await driver.listIncidents({ limit: 10 });
      expect(page.items.map((i) => i.incidentId)).toEqual(["inc_b", "inc_c", "inc_a"]);
    });

    it("listIncidents paginates via cursor", async () => {
      for (let i = 0; i < 5; i++) {
        await driver.createIncident(
          makePacket({
            incidentId: `inc_page_${i}`,
            packetId: `pkt_page_${i}`,
            openedAt: `2026-03-09T0${i}:00:00Z`,
          }),
        );
      }

      const page1 = await driver.listIncidents({ limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).toBeDefined();

      const page2 = await driver.listIncidents({ limit: 2, cursor: page1.nextCursor });
      expect(page2.items).toHaveLength(2);

      const page3 = await driver.listIncidents({ limit: 2, cursor: page2.nextCursor });
      expect(page3.items).toHaveLength(1);
      expect(page3.nextCursor).toBeUndefined();
    });

    // deleteExpiredIncidents ─────────────────────────────────────────────────

    it("deleteExpiredIncidents removes closed incidents older than cutoff", async () => {
      const old = makePacket({ incidentId: "inc_old", packetId: "pkt_old", openedAt: "2020-01-01T00:00:00Z" });
      const recent = makePacket({ incidentId: "inc_recent", packetId: "pkt_recent", openedAt: "2026-03-09T00:00:00Z" });
      await driver.createIncident(old);
      await driver.createIncident(recent);
      await driver.updateIncidentStatus("inc_old", "closed");
      await driver.updateIncidentStatus("inc_recent", "closed");

      await driver.deleteExpiredIncidents(new Date("2021-01-01T00:00:00Z"));

      expect(await driver.getIncident("inc_old")).toBeNull();
      expect(await driver.getIncident("inc_recent")).not.toBeNull();
    });

    it("deleteExpiredIncidents does not remove open incidents", async () => {
      const p = makePacket({ incidentId: "inc_open_old", packetId: "pkt_open_old", openedAt: "2020-01-01T00:00:00Z" });
      await driver.createIncident(p);
      // status remains "open"

      await driver.deleteExpiredIncidents(new Date("2025-01-01T00:00:00Z"));
      expect(await driver.getIncident("inc_open_old")).not.toBeNull();
    });

    // saveThinEvent / listThinEvents ─────────────────────────────────────────

    it("saveThinEvent stores events retrievable by listThinEvents", async () => {
      const e1 = makeThinEvent({ event_id: "evt_001" });
      const e2 = makeThinEvent({ event_id: "evt_002" });
      await driver.saveThinEvent(e1);
      await driver.saveThinEvent(e2);

      const events = await driver.listThinEvents();
      expect(events).toHaveLength(2);
      expect(events.map((e) => e.event_id)).toContain("evt_001");
    });

    it("listThinEvents returns empty array when no events stored", async () => {
      const events = await driver.listThinEvents();
      expect(events).toHaveLength(0);
    });

    it("saveThinEvent throws on duplicate event_id", async () => {
      const e = makeThinEvent({ event_id: "evt_dup" });
      await driver.saveThinEvent(e);
      await expect(driver.saveThinEvent(e)).rejects.toThrow();
    });

    // appendRawEvidence ────────────────────────────────────────────────────────

    it("appendRawEvidence appends metricEvidence to rawState", async () => {
      const packet = makePacket();
      await driver.createIncident(packet);
      await driver.appendRawEvidence(packet.incidentId, {
        metricEvidence: [
          { name: "http.duration", service: "web", environment: "staging", startTimeMs: 1000, summary: { count: 1 } },
        ],
      });
      const rawState = await driver.getRawState(packet.incidentId);
      expect(rawState!.metricEvidence).toHaveLength(1);
      expect(rawState!.metricEvidence[0].name).toBe("http.duration");
    });

    it("appendRawEvidence appends logEvidence to rawState", async () => {
      const packet = makePacket();
      await driver.createIncident(packet);
      await driver.appendRawEvidence(packet.incidentId, {
        logEvidence: [
          { service: "web", environment: "staging", timestamp: "2026-03-15T00:00:00Z", startTimeMs: 1000, severity: "ERROR", body: "fail", attributes: {} },
        ],
      });
      const rawState = await driver.getRawState(packet.incidentId);
      expect(rawState!.logEvidence).toHaveLength(1);
      expect(rawState!.logEvidence[0].severity).toBe("ERROR");
    });

    it("appendRawEvidence accumulates across calls", async () => {
      const packet = makePacket();
      await driver.createIncident(packet);
      await driver.appendRawEvidence(packet.incidentId, {
        metricEvidence: [{ name: "m1", service: "s", environment: "e", startTimeMs: 1, summary: {} }],
      });
      await driver.appendRawEvidence(packet.incidentId, {
        metricEvidence: [{ name: "m2", service: "s", environment: "e", startTimeMs: 2, summary: {} }],
        logEvidence: [{ service: "s", environment: "e", timestamp: "t", startTimeMs: 1, severity: "WARN", body: "b", attributes: {} }],
      });
      const rawState = await driver.getRawState(packet.incidentId);
      expect(rawState!.metricEvidence).toHaveLength(2);
      expect(rawState!.logEvidence).toHaveLength(1);
    });

    it("appendRawEvidence is no-op for unknown incidentId", async () => {
      await expect(
        driver.appendRawEvidence("inc_unknown", {
          metricEvidence: [{ name: "x", service: "s", environment: "e", startTimeMs: 1, summary: {} }],
        }),
      ).resolves.toBeUndefined();
    });

    // appendSpans ────────────────────────────────────────────────────────────

    it("createIncident initializes rawState with empty arrays", async () => {
      const packet = makePacket();
      await driver.createIncident(packet);
      const rawState = await driver.getRawState(packet.incidentId);
      expect(rawState).not.toBeNull();
      expect(rawState?.spans).toEqual([]);
      expect(rawState?.anomalousSignals).toEqual([]);
      expect(rawState?.metricEvidence).toEqual([]);
      expect(rawState?.logEvidence).toEqual([]);
      expect(rawState?.platformEvents).toEqual([]);
    });

    it("appendSpans accumulates spans across multiple calls", async () => {
      const packet = makePacket();
      await driver.createIncident(packet);

      const span1: ExtractedSpan = {
        traceId: "trace_001", spanId: "span_001", serviceName: "web",
        environment: "production", spanStatusCode: 2, durationMs: 100,
        startTimeMs: 1000, exceptionCount: 0,
      };
      const span2: ExtractedSpan = {
        traceId: "trace_001", spanId: "span_002", serviceName: "web",
        environment: "production", spanStatusCode: 0, durationMs: 6000,
        startTimeMs: 1100, exceptionCount: 0,
      };

      await driver.appendSpans(packet.incidentId, [span1]);
      await driver.appendSpans(packet.incidentId, [span2]);

      const rawState = await driver.getRawState(packet.incidentId);
      expect(rawState?.spans).toHaveLength(2);
      expect(rawState?.spans[0].spanId).toBe("span_001");
      expect(rawState?.spans[1].spanId).toBe("span_002");
    });

    it("appendSpans is a no-op for unknown incidentId", async () => {
      const span: ExtractedSpan = {
        traceId: "t", spanId: "s", serviceName: "svc",
        environment: "prod", spanStatusCode: 0, durationMs: 50,
        startTimeMs: 0, exceptionCount: 0,
      };
      // Should not throw
      await driver.appendSpans("inc_unknown", [span]);
    });

    // appendAnomalousSignals ─────────────────────────────────────────────────

    it("appendAnomalousSignals accumulates signals across multiple calls", async () => {
      const packet = makePacket();
      await driver.createIncident(packet);

      const sig1: AnomalousSignal = {
        signal: "http_429", firstSeenAt: "2026-03-09T03:00:00Z",
        entity: "stripe", spanId: "span_001",
      };
      const sig2: AnomalousSignal = {
        signal: "slow_span", firstSeenAt: "2026-03-09T03:01:00Z",
        entity: "web", spanId: "span_002",
      };

      await driver.appendAnomalousSignals(packet.incidentId, [sig1]);
      await driver.appendAnomalousSignals(packet.incidentId, [sig2]);

      const rawState = await driver.getRawState(packet.incidentId);
      expect(rawState?.anomalousSignals).toHaveLength(2);
      expect(rawState?.anomalousSignals[0].signal).toBe("http_429");
      expect(rawState?.anomalousSignals[1].signal).toBe("slow_span");
    });

    it("appendAnomalousSignals is a no-op for unknown incidentId", async () => {
      const sig: AnomalousSignal = {
        signal: "http_500", firstSeenAt: "2026-03-09T03:00:00Z",
        entity: "web", spanId: "span_x",
      };
      // Should not throw
      await driver.appendAnomalousSignals("inc_unknown", [sig]);
    });

    // appendPlatformEvents ───────────────────────────────────────────────────

    it("appendPlatformEvents accumulates platform events across multiple calls", async () => {
      const packet = makePacket();
      await driver.createIncident(packet);

      const event1: PlatformEvent = {
        eventType: "deploy",
        timestamp: "2026-03-09T03:00:00Z",
        environment: "production",
        description: "checkout deploy",
        service: "web",
      };
      const event2: PlatformEvent = {
        eventType: "provider_incident",
        timestamp: "2026-03-09T03:01:00Z",
        environment: "production",
        description: "stripe degraded",
        provider: "stripe",
        eventId: "evt_provider_1",
      };

      await driver.appendPlatformEvents(packet.incidentId, [event1]);
      await driver.appendPlatformEvents(packet.incidentId, [event2]);

      const rawState = await driver.getRawState(packet.incidentId);
      expect(rawState?.platformEvents).toHaveLength(2);
      expect(rawState?.platformEvents[0]?.eventType).toBe("deploy");
      expect(rawState?.platformEvents[1]?.eventId).toBe("evt_provider_1");
    });

    it("appendPlatformEvents is a no-op for unknown incidentId", async () => {
      const event: PlatformEvent = {
        eventType: "deploy",
        timestamp: "2026-03-09T03:00:00Z",
        environment: "production",
        description: "checkout deploy",
      };

      await expect(driver.appendPlatformEvents("inc_unknown", [event])).resolves.toBeUndefined();
    });

    // getRawState ────────────────────────────────────────────────────────────

    it("getRawState returns null for unknown incidentId", async () => {
      expect(await driver.getRawState("inc_unknown")).toBeNull();
    });

    it("getRawState reflects spans and signals appended independently", async () => {
      const packet = makePacket();
      await driver.createIncident(packet);

      const span: ExtractedSpan = {
        traceId: "t1", spanId: "s1", serviceName: "api",
        environment: "production", spanStatusCode: 2, durationMs: 200,
        startTimeMs: 5000, exceptionCount: 1,
      };
      const sig: AnomalousSignal = {
        signal: "exception", firstSeenAt: "2026-03-09T03:00:00Z",
        entity: "api", spanId: "s1",
      };

      await driver.appendSpans(packet.incidentId, [span]);
      await driver.appendAnomalousSignals(packet.incidentId, [sig]);

      const rawState = await driver.getRawState(packet.incidentId);
      expect(rawState?.spans).toHaveLength(1);
      expect(rawState?.anomalousSignals).toHaveLength(1);
      expect(rawState?.spans[0].exceptionCount).toBe(1);
      expect(rawState?.anomalousSignals[0].signal).toBe("exception");
    });

    it("createIncident upsert preserves rawState accumulated before re-insert", async () => {
      const packet = makePacket();
      await driver.createIncident(packet);

      const span: ExtractedSpan = {
        traceId: "t1", spanId: "s1", serviceName: "web",
        environment: "production", spanStatusCode: 0, durationMs: 10,
        startTimeMs: 0, exceptionCount: 0,
      };
      await driver.appendSpans(packet.incidentId, [span]);

      // Upsert (re-create) should preserve rawState
      const updatedPacket = makePacket({ packetId: "pkt_test_001_v2" });
      await driver.createIncident(updatedPacket);

      const rawState = await driver.getRawState(packet.incidentId);
      expect(rawState?.spans).toHaveLength(1);
    });

  });
}
