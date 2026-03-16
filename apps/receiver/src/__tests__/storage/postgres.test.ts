/**
 * PostgresAdapter contract tests.
 *
 * Requires a running Postgres instance. Set DATABASE_URL before running:
 *   DATABASE_URL=postgres://... pnpm --filter @3amoncall/receiver test
 *
 * In CI this is provided by the GitHub Actions postgres service container.
 * Tests are skipped automatically when DATABASE_URL is not set.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { PostgresAdapter } from "../../storage/drizzle/postgres.js";
import { runStorageSuite, makePacket, makeSpan } from "./shared-suite.js";

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
        sql`TRUNCATE TABLE incidents, thin_events RESTART IDENTITY CASCADE`,
      );
    },
  });

  // ── Postgres-specific: concurrent append race regression tests ──────────────

  describe("PostgresAdapter — concurrent append (race regression)", () => {
    beforeEach(async () => {
      await adapter.execute(
        sql`TRUNCATE TABLE incidents, thin_events RESTART IDENTITY CASCADE`,
      );
    });

    it("concurrent appendSpans does not lose updates (Promise.all)", async () => {
      const packet = makePacket({ incidentId: "inc_race_spans", packetId: "pkt_race_spans" });
      await adapter.createIncident(packet);

      const batch1 = [makeSpan("span_r1"), makeSpan("span_r2"), makeSpan("span_r3")];
      const batch2 = [makeSpan("span_r4"), makeSpan("span_r5")];

      await Promise.all([
        adapter.appendSpans(packet.incidentId, batch1),
        adapter.appendSpans(packet.incidentId, batch2),
      ]);

      const rawState = await adapter.getRawState(packet.incidentId);
      expect(rawState).not.toBeNull();
      expect(rawState!.spans).toHaveLength(batch1.length + batch2.length);
    });

    it("concurrent appendAnomalousSignals does not lose updates (Promise.all)", async () => {
      const packet = makePacket({ incidentId: "inc_race_signals", packetId: "pkt_race_signals" });
      await adapter.createIncident(packet);

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

      const rawState = await adapter.getRawState(packet.incidentId);
      expect(rawState).not.toBeNull();
      expect(rawState!.anomalousSignals).toHaveLength(batch1.length + batch2.length);
    });

    it("concurrent appendPlatformEvents does not lose updates (Promise.all)", async () => {
      const packet = makePacket({ incidentId: "inc_race_events", packetId: "pkt_race_events" });
      await adapter.createIncident(packet);

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

      const rawState = await adapter.getRawState(packet.incidentId);
      expect(rawState).not.toBeNull();
      expect(rawState!.platformEvents).toHaveLength(batch1.length + batch2.length);
    });

    it("concurrent appendRawEvidence does not lose updates (Promise.all)", async () => {
      const packet = makePacket({ incidentId: "inc_race_evidence", packetId: "pkt_race_evidence" });
      await adapter.createIncident(packet);

      await Promise.all([
        adapter.appendRawEvidence(packet.incidentId, {
          metricEvidence: [
            { name: "m1", service: "s", environment: "e", startTimeMs: 1, summary: {} },
            { name: "m2", service: "s", environment: "e", startTimeMs: 2, summary: {} },
          ],
        }),
        adapter.appendRawEvidence(packet.incidentId, {
          metricEvidence: [
            { name: "m3", service: "s", environment: "e", startTimeMs: 3, summary: {} },
          ],
          logEvidence: [
            { service: "s", environment: "e", timestamp: "t", startTimeMs: 1, severity: "ERROR", body: "b", attributes: {} },
          ],
        }),
      ]);

      const rawState = await adapter.getRawState(packet.incidentId);
      expect(rawState).not.toBeNull();
      expect(rawState!.metricEvidence).toHaveLength(3);
      expect(rawState!.logEvidence).toHaveLength(1);
    });
  });
}
