/**
 * PostgresAdapter contract tests.
 *
 * Requires a running Postgres instance. Set DATABASE_URL before running:
 *   DATABASE_URL=postgres://... pnpm --filter @3am/receiver test
 *
 * In CI this is provided by the GitHub Actions postgres service container.
 * Tests are skipped automatically when DATABASE_URL is not set.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { PostgresAdapter } from "../../storage/drizzle/postgres.js";
import { runStorageSuite, makePacket, makeMembership } from "./shared-suite.js";

const DATABASE_URL = process.env["DATABASE_URL"];

if (!DATABASE_URL) {
  describe("PostgresAdapter", () => {
    it.skip("skipped — DATABASE_URL not set", () => {});
  });
} else {
  let adapter: PostgresAdapter;

  beforeAll(async () => {
    adapter = new PostgresAdapter(DATABASE_URL);
    await adapter.migrate();
  });

  afterAll(async () => {
    await adapter.close();
  });

  runStorageSuite("PostgresAdapter", () => adapter, {
    cleanup: async () => {
      // Truncate between each test for isolation (Postgres is a shared process)
      await adapter.execute(
        sql`TRUNCATE TABLE incidents, thin_events, settings RESTART IDENTITY CASCADE`,
      );
    },
  });

  // ── Postgres-specific: concurrent append race regression tests ──────────────

  describe("PostgresAdapter — concurrent append (race regression)", () => {
    beforeEach(async () => {
      await adapter.execute(
        sql`TRUNCATE TABLE incidents, thin_events, settings RESTART IDENTITY CASCADE`,
      );
    });

    it("concurrent appendSpanMembership does not lose updates (Promise.all)", async () => {
      const packet = makePacket({ incidentId: "inc_race_spans", packetId: "pkt_race_spans" });
      await adapter.createIncident(packet, makeMembership());

      const batch1 = ["trace_001:span_r1", "trace_001:span_r2", "trace_001:span_r3"];
      const batch2 = ["trace_001:span_r4", "trace_001:span_r5"];

      await Promise.all([
        adapter.appendSpanMembership(packet.incidentId, batch1),
        adapter.appendSpanMembership(packet.incidentId, batch2),
      ]);

      const incident = await adapter.getIncident(packet.incidentId);
      expect(incident).not.toBeNull();
      // Initial membership has 1 + batch1 (3) + batch2 (2) = 6
      // (dedup may reduce if any overlap with initial)
      const allIds = new Set([...makeMembership().spanMembership, ...batch1, ...batch2]);
      expect(incident!.spanMembership.length).toBe(allIds.size);
    });

    it("concurrent appendAnomalousSignals does not lose updates (Promise.all)", async () => {
      const packet = makePacket({ incidentId: "inc_race_signals", packetId: "pkt_race_signals" });
      await adapter.createIncident(packet, makeMembership({ anomalousSignals: [] }));

      const batch1 = [
        { signal: "http_429", firstSeenAt: "2026-03-09T03:00:00Z", entity: "stripe", spanId: "s1" },
        { signal: "http_500", firstSeenAt: "2026-03-09T03:00:01Z", entity: "web", spanId: "s2" },
      ];
      const batch2 = [
        { signal: "slow_span", firstSeenAt: "2026-03-09T03:01:00Z", entity: "web", spanId: "s3" },
      ];

      await Promise.all([
        adapter.appendAnomalousSignals(packet.incidentId, batch1),
        adapter.appendAnomalousSignals(packet.incidentId, batch2),
      ]);

      const incident = await adapter.getIncident(packet.incidentId);
      expect(incident).not.toBeNull();
      expect(incident!.anomalousSignals).toHaveLength(batch1.length + batch2.length);
    });

    it("concurrent appendPlatformEvents does not lose updates (Promise.all)", async () => {
      const packet = makePacket({ incidentId: "inc_race_events", packetId: "pkt_race_events" });
      await adapter.createIncident(packet, makeMembership());

      const batch1 = [
        { eventType: "deploy" as const, timestamp: "2026-03-09T03:00:00Z", environment: "production", description: "d1" },
      ];
      const batch2 = [
        { eventType: "provider_incident" as const, timestamp: "2026-03-09T03:01:00Z", environment: "production", description: "d2", provider: "stripe", eventId: "evt_1" },
        { eventType: "deploy" as const, timestamp: "2026-03-09T03:02:00Z", environment: "production", description: "d3" },
      ];

      await Promise.all([
        adapter.appendPlatformEvents(packet.incidentId, batch1),
        adapter.appendPlatformEvents(packet.incidentId, batch2),
      ]);

      const incident = await adapter.getIncident(packet.incidentId);
      expect(incident).not.toBeNull();
      expect(incident!.platformEvents).toHaveLength(batch1.length + batch2.length);
    });
  });
}
