/**
 * Shared StorageDriver contract test suite.
 *
 * Import and call `runStorageSuite` in each adapter's test file.
 * This ensures all adapters satisfy the same behavioural contract.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { StorageDriver, AnomalousSignal, InitialMembership } from "../../storage/interface.js";
import { createEmptyTelemetryScope } from "../../storage/interface.js";
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

export function makeMembership(overrides: Partial<InitialMembership> = {}): InitialMembership {
  return {
    telemetryScope: {
      ...createEmptyTelemetryScope(),
      windowStartMs: 1741392900000,  // 2026-03-09T02:55:00Z
      windowEndMs: 1741393500000,    // 2026-03-09T03:05:00Z
      detectTimeMs: 1741393200000,   // 2026-03-09T03:00:00Z
      environment: "production",
      memberServices: ["web"],
      dependencyServices: ["stripe"],
    },
    spanMembership: ["trace_abc:span_001"],
    anomalousSignals: [{
      signal: "http_429",
      firstSeenAt: "2026-03-09T03:00:00Z",
      entity: "stripe",
      spanId: "span_001",
    }],
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

    it("nextIncidentSequence returns incrementing values", async () => {
      await expect(driver.nextIncidentSequence()).resolves.toBe(1);
      await expect(driver.nextIncidentSequence()).resolves.toBe(2);
    });

    // createIncident ─────────────────────────────────────────────────────────

    it("createIncident stores an incident retrievable by getIncident", async () => {
      const packet = makePacket();
      const membership = makeMembership();
      await driver.createIncident(packet, membership);
      const incident = await driver.getIncident(packet.incidentId);
      expect(incident).not.toBeNull();
      expect(incident?.incidentId).toBe(packet.incidentId);
      expect(incident?.status).toBe("open");
      expect(incident?.openedAt).toBe(packet.openedAt);
      expect(incident?.lastActivityAt).toBe(packet.openedAt);
    });

    it("createIncident is a no-op for existing incidentId — use updatePacket instead", async () => {
      const packet = makePacket();
      const membership = makeMembership();
      await driver.createIncident(packet, membership);
      const dr = makeDiagnosis(packet.incidentId, packet.packetId);
      await driver.appendDiagnosis(packet.incidentId, dr);

      // Re-insert with a different packet — should be a no-op
      const updatedPacket = makePacket({ packetId: "pkt_test_001_v2" });
      await driver.createIncident(updatedPacket, membership);

      const incident = await driver.getIncident(packet.incidentId);
      // Packet should NOT be updated (no-op), original packetId preserved
      expect(incident?.packet.packetId).toBe("pkt_test_001");
      // diagnosisResult still preserved
      expect(incident?.diagnosisResult?.summary.what_happened).toBe("Rate limit cascade.");
    });

    // getIncidentByPacketId ──────────────────────────────────────────────────

    it("getIncidentByPacketId returns incident matching the packetId", async () => {
      const packet = makePacket();
      await driver.createIncident(packet, makeMembership());
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
      await driver.createIncident(packet, makeMembership());
      await driver.updateIncidentStatus(packet.incidentId, "closed");

      const incident = await driver.getIncident(packet.incidentId);
      expect(incident?.status).toBe("closed");
      expect(incident?.closedAt).toBeDefined();
    });

    it("touchIncidentActivity updates lastActivityAt", async () => {
      const packet = makePacket();
      await driver.createIncident(packet, makeMembership());
      await driver.touchIncidentActivity(packet.incidentId, "2026-03-09T04:00:00Z");

      const incident = await driver.getIncident(packet.incidentId);
      expect(incident?.lastActivityAt).toBe("2026-03-09T04:00:00Z");
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
      await driver.createIncident(packet, makeMembership());
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
      await driver.createIncident(p1, makeMembership());
      await driver.createIncident(p2, makeMembership());
      await driver.createIncident(p3, makeMembership());

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
          makeMembership(),
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

    it("deleteExpiredIncidents removes closed incidents when closedAt is before cutoff", async () => {
      const old = makePacket({ incidentId: "inc_old", packetId: "pkt_old" });
      const open = makePacket({ incidentId: "inc_open", packetId: "pkt_open" });
      await driver.createIncident(old, makeMembership());
      await driver.createIncident(open, makeMembership());
      await driver.updateIncidentStatus("inc_old", "closed");

      await driver.deleteExpiredIncidents(new Date("2100-01-01T00:00:00Z"));

      expect(await driver.getIncident("inc_old")).toBeNull();
      expect(await driver.getIncident("inc_open")).not.toBeNull();
    });

    it("deleteExpiredIncidents keeps closed incidents when closedAt is after cutoff", async () => {
      const packet = makePacket({ incidentId: "inc_closed_recent", packetId: "pkt_closed_recent" });
      await driver.createIncident(packet, makeMembership());
      await driver.updateIncidentStatus("inc_closed_recent", "closed");

      await driver.deleteExpiredIncidents(new Date("2000-01-01T00:00:00Z"));

      expect(await driver.getIncident("inc_closed_recent")).not.toBeNull();
    });

    it("deleteExpiredIncidents does not remove open incidents", async () => {
      const p = makePacket({ incidentId: "inc_open_old", packetId: "pkt_open_old", openedAt: "2020-01-01T00:00:00Z" });
      await driver.createIncident(p, makeMembership());
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

    // updatePacket ──────────────────────────────────────────────────────────

    it("updatePacket updates packet but preserves compact fields", async () => {
      const packet = makePacket();
      const membership = makeMembership();
      await driver.createIncident(packet, membership);

      const newPacket = makePacket({
        packetId: "pkt_test_001",
        generation: 2,
      });
      await driver.updatePacket(packet.incidentId, newPacket);

      const incident = await driver.getIncident(packet.incidentId);
      expect(incident?.packet.generation).toBe(2);
      // Compact fields preserved
      expect(incident?.spanMembership).toEqual(membership.spanMembership);
      expect(incident?.anomalousSignals).toHaveLength(1);
    });

    it("updatePacket is a no-op for unknown incidentId", async () => {
      const packet = makePacket();
      await expect(driver.updatePacket("inc_unknown", packet)).resolves.toBeUndefined();
    });

    // expandTelemetryScope ──────────────────────────────────────────────────

    it("expandTelemetryScope monotonically expands window and services", async () => {
      const packet = makePacket();
      const membership = makeMembership({
        telemetryScope: {
          ...createEmptyTelemetryScope(),
          windowStartMs: 1000,
          windowEndMs: 2000,
          detectTimeMs: 1000,
          environment: "production",
          memberServices: ["web"],
          dependencyServices: ["stripe"],
        },
      });
      await driver.createIncident(packet, membership);

      await driver.expandTelemetryScope(packet.incidentId, {
        windowStartMs: 500,   // earlier → should expand
        windowEndMs: 1500,    // earlier → should NOT expand
        memberServices: ["api"],
        dependencyServices: ["redis"],
      });

      const incident = await driver.getIncident(packet.incidentId);
      expect(incident?.telemetryScope.windowStartMs).toBe(500);    // min(1000, 500)
      expect(incident?.telemetryScope.windowEndMs).toBe(2000);      // max(2000, 1500)
      expect(incident?.telemetryScope.memberServices).toContain("web");
      expect(incident?.telemetryScope.memberServices).toContain("api");
      expect(incident?.telemetryScope.dependencyServices).toContain("stripe");
      expect(incident?.telemetryScope.dependencyServices).toContain("redis");
    });

    it("expandTelemetryScope is a no-op for unknown incidentId", async () => {
      await expect(
        driver.expandTelemetryScope("inc_unknown", {
          windowStartMs: 0, windowEndMs: 1000, memberServices: [], dependencyServices: [],
        }),
      ).resolves.toBeUndefined();
    });

    // appendSpanMembership ──────────────────────────────────────────────────

    it("appendSpanMembership adds span IDs and deduplicates", async () => {
      const packet = makePacket();
      const membership = makeMembership({
        spanMembership: ["trace_abc:span_001"],
      });
      await driver.createIncident(packet, membership);

      await driver.appendSpanMembership(packet.incidentId, [
        "trace_abc:span_002",
        "trace_abc:span_001",  // duplicate, should be ignored
      ]);

      const incident = await driver.getIncident(packet.incidentId);
      expect(incident?.spanMembership).toContain("trace_abc:span_001");
      expect(incident?.spanMembership).toContain("trace_abc:span_002");
      // No duplicates
      const unique = new Set(incident?.spanMembership);
      expect(unique.size).toBe(incident?.spanMembership.length);
    });

    it("appendSpanMembership is a no-op for unknown incidentId", async () => {
      await expect(
        driver.appendSpanMembership("inc_unknown", ["t:s"]),
      ).resolves.toBeUndefined();
    });

    // appendAnomalousSignals ─────────────────────────────────────────────────

    it("appendAnomalousSignals accumulates signals across multiple calls", async () => {
      const packet = makePacket();
      await driver.createIncident(packet, makeMembership({
        anomalousSignals: [],
      }));

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

      const incident = await driver.getIncident(packet.incidentId);
      expect(incident?.anomalousSignals).toHaveLength(2);
      expect(incident?.anomalousSignals[0]?.signal).toBe("http_429");
      expect(incident?.anomalousSignals[1]?.signal).toBe("slow_span");
    });

    it("appendAnomalousSignals caps at MAX_ANOMALOUS_SIGNALS (B-12)", async () => {
      const { MAX_ANOMALOUS_SIGNALS } = await import("../../storage/interface.js");
      const packet = makePacket();
      await driver.createIncident(packet, makeMembership({
        anomalousSignals: [],
      }));

      // Generate signals exceeding the cap
      const signals: AnomalousSignal[] = Array.from(
        { length: MAX_ANOMALOUS_SIGNALS + 50 },
        (_, i) => ({
          signal: `sig_${i}`,
          firstSeenAt: new Date(Date.now() + i * 1000).toISOString(),
          entity: "web",
          spanId: `span_${i}`,
        }),
      );

      await driver.appendAnomalousSignals(packet.incidentId, signals);

      const incident = await driver.getIncident(packet.incidentId);
      expect(incident?.anomalousSignals.length).toBeLessThanOrEqual(MAX_ANOMALOUS_SIGNALS);
      // Newest signals should be kept, oldest dropped
      expect(incident?.anomalousSignals[0]?.signal).toBe("sig_50");
      expect(incident?.anomalousSignals[incident!.anomalousSignals.length - 1]?.signal).toBe(
        `sig_${MAX_ANOMALOUS_SIGNALS + 49}`,
      );
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
      await driver.createIncident(packet, makeMembership());

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

      const incident = await driver.getIncident(packet.incidentId);
      expect(incident?.platformEvents).toHaveLength(2);
      expect(incident?.platformEvents[0]?.eventType).toBe("deploy");
      expect(incident?.platformEvents[1]?.eventId).toBe("evt_provider_1");
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

    // claimDiagnosisDispatch ─────────────────────────────────────────────────

    it("claimDiagnosisDispatch returns true on first call, false on second", async () => {
      const packet = makePacket();
      await driver.createIncident(packet, makeMembership());

      const first = await driver.claimDiagnosisDispatch(packet.incidentId);
      expect(first).toBe(true);

      const second = await driver.claimDiagnosisDispatch(packet.incidentId);
      expect(second).toBe(false);
    });

    it("claimDiagnosisDispatch sets diagnosisDispatchedAt on the incident", async () => {
      const packet = makePacket();
      await driver.createIncident(packet, makeMembership());

      // Before claim
      const before = await driver.getIncident(packet.incidentId);
      expect(before?.diagnosisDispatchedAt).toBeUndefined();

      await driver.claimDiagnosisDispatch(packet.incidentId);

      const after = await driver.getIncident(packet.incidentId);
      expect(after?.diagnosisDispatchedAt).toBeDefined();
    });

    it("claimDiagnosisDispatch can reclaim an expired lease", async () => {
      const packet = makePacket();
      await driver.createIncident(packet, makeMembership());

      const first = await driver.claimDiagnosisDispatch(packet.incidentId, 1);
      expect(first).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 5));

      const second = await driver.claimDiagnosisDispatch(packet.incidentId, 1);
      expect(second).toBe(true);
    });

    it("claimDiagnosisDispatch returns false for unknown incidentId", async () => {
      const result = await driver.claimDiagnosisDispatch("inc_unknown");
      expect(result).toBe(false);
    });

    // getSettings / setSettings ─────────────────────────────────────────────

    it("getSettings returns null for non-existent key", async () => {
      const value = await driver.getSettings("nonexistent_key");
      expect(value).toBeNull();
    });

    it("setSettings then getSettings returns stored value", async () => {
      await driver.setSettings("test_key", "test_value");
      const value = await driver.getSettings("test_key");
      expect(value).toBe("test_value");
    });

    it("setSettings overwrites existing value", async () => {
      await driver.setSettings("overwrite_key", "first");
      await driver.setSettings("overwrite_key", "second");
      const value = await driver.getSettings("overwrite_key");
      expect(value).toBe("second");
    });

    // createIncident initializes compact fields ──────────────────────────────

    it("createIncident initializes telemetryScope, spanMembership, anomalousSignals, and platformEvents", async () => {
      const packet = makePacket();
      const membership = makeMembership();
      await driver.createIncident(packet, membership);

      const incident = await driver.getIncident(packet.incidentId);
      expect(incident).not.toBeNull();
      expect(incident?.telemetryScope.environment).toBe("production");
      expect(incident?.telemetryScope.memberServices).toContain("web");
      expect(incident?.spanMembership).toHaveLength(1);
      expect(incident?.anomalousSignals).toHaveLength(1);
      expect(incident?.platformEvents).toEqual([]);
    });

  });
}
