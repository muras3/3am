/**
 * Shared StorageDriver contract test suite.
 *
 * Import and call `runStorageSuite` in each adapter's test file.
 * This ensures all adapters satisfy the same behavioural contract.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { StorageDriver } from "../../storage/interface.js";
import type { IncidentPacket, DiagnosisResult, ThinEvent } from "@3amoncall/core";

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
      // diagnosisResult must be preserved across upsert
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
  });
}
