/**
 * Shared TelemetryStoreDriver contract test suite.
 *
 * Import and call `runTelemetryStoreSuite` in each adapter's test file.
 * This ensures all adapters satisfy the same behavioural contract.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type {
  TelemetryStoreDriver,
  TelemetrySpan,
  TelemetryMetric,
  TelemetryLog,
} from "../../telemetry/interface.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = Date.now();

export function makeSpan(overrides: Partial<TelemetrySpan> = {}): TelemetrySpan {
  return {
    traceId: "trace_001",
    spanId: "span_001",
    serviceName: "web",
    environment: "production",
    spanName: "GET /checkout",
    spanStatusCode: 0,
    durationMs: 100,
    startTimeMs: 1000,
    exceptionCount: 0,
    attributes: {},
    ingestedAt: NOW,
    ...overrides,
  };
}

export function makeMetric(overrides: Partial<TelemetryMetric> = {}): TelemetryMetric {
  return {
    service: "web",
    environment: "production",
    name: "http.duration",
    startTimeMs: 1000,
    summary: { count: 10, sum: 500 },
    ingestedAt: NOW,
    ...overrides,
  };
}

export function makeLog(overrides: Partial<TelemetryLog> = {}): TelemetryLog {
  return {
    service: "web",
    environment: "production",
    timestamp: "2026-03-09T03:00:00Z",
    startTimeMs: 1000,
    severity: "ERROR",
    severityNumber: 17,
    body: "Connection refused",
    bodyHash: "abc123def456gh78",
    attributes: {},
    ingestedAt: NOW,
    ...overrides,
  };
}

// ── Shared suite ──────────────────────────────────────────────────────────────

export function runTelemetryStoreSuite(
  name: string,
  getDriver: () => TelemetryStoreDriver,
  opts?: { cleanup?: () => Promise<void> },
): void {
  describe(`TelemetryStoreDriver contract — ${name}`, () => {
    let driver: TelemetryStoreDriver;

    beforeEach(async () => {
      if (opts?.cleanup) await opts.cleanup();
      driver = getDriver();
    });

    // ── ingestSpans ─────────────────────────────────────────────────────────

    describe("ingestSpans", () => {
      it("stores spans retrievable by querySpans", async () => {
        const span = makeSpan();
        await driver.ingestSpans([span]);

        const result = await driver.querySpans({ startMs: 0, endMs: 2000 });
        expect(result).toHaveLength(1);
        expect(result[0]!.traceId).toBe("trace_001");
        expect(result[0]!.spanId).toBe("span_001");
        expect(result[0]!.serviceName).toBe("web");
        expect(result[0]!.durationMs).toBe(100);
      });

      it("UPSERT dedup on (traceId, spanId) — last write wins", async () => {
        const span1 = makeSpan({ durationMs: 100 });
        const span2 = makeSpan({ durationMs: 200 });
        await driver.ingestSpans([span1]);
        await driver.ingestSpans([span2]);

        const result = await driver.querySpans({ startMs: 0, endMs: 2000 });
        expect(result).toHaveLength(1);
        expect(result[0]!.durationMs).toBe(200);
      });

      it("accumulates spans with different keys across calls", async () => {
        const span1 = makeSpan({ spanId: "span_a" });
        const span2 = makeSpan({ spanId: "span_b" });
        await driver.ingestSpans([span1]);
        await driver.ingestSpans([span2]);

        const result = await driver.querySpans({ startMs: 0, endMs: 2000 });
        expect(result).toHaveLength(2);
      });

      it("preserves optional fields", async () => {
        const span = makeSpan({
          parentSpanId: "parent_001",
          httpRoute: "/checkout",
          httpStatusCode: 500,
          peerService: "stripe",
          attributes: { "http.request.method": "POST" },
        });
        await driver.ingestSpans([span]);

        const result = await driver.querySpans({ startMs: 0, endMs: 2000 });
        expect(result[0]!.parentSpanId).toBe("parent_001");
        expect(result[0]!.httpRoute).toBe("/checkout");
        expect(result[0]!.httpStatusCode).toBe(500);
        expect(result[0]!.peerService).toBe("stripe");
        expect(result[0]!.attributes).toEqual({ "http.request.method": "POST" });
      });

      it("handles empty array without error", async () => {
        await expect(driver.ingestSpans([])).resolves.toBeUndefined();
      });
    });

    // ── ingestMetrics ───────────────────────────────────────────────────────

    describe("ingestMetrics", () => {
      it("stores metrics retrievable by queryMetrics", async () => {
        const metric = makeMetric();
        await driver.ingestMetrics([metric]);

        const result = await driver.queryMetrics({ startMs: 0, endMs: 2000 });
        expect(result).toHaveLength(1);
        expect(result[0]!.name).toBe("http.duration");
        expect(result[0]!.summary).toEqual({ count: 10, sum: 500 });
      });

      it("UPSERT dedup on (service, name, startTimeMs) — last write wins", async () => {
        const m1 = makeMetric({ summary: { count: 5 } });
        const m2 = makeMetric({ summary: { count: 15 } });
        await driver.ingestMetrics([m1]);
        await driver.ingestMetrics([m2]);

        const result = await driver.queryMetrics({ startMs: 0, endMs: 2000 });
        expect(result).toHaveLength(1);
        expect(result[0]!.summary).toEqual({ count: 15 });
      });

      it("accumulates metrics with different keys across calls", async () => {
        const m1 = makeMetric({ name: "metric_a" });
        const m2 = makeMetric({ name: "metric_b" });
        await driver.ingestMetrics([m1]);
        await driver.ingestMetrics([m2]);

        const result = await driver.queryMetrics({ startMs: 0, endMs: 2000 });
        expect(result).toHaveLength(2);
      });

      it("handles empty array without error", async () => {
        await expect(driver.ingestMetrics([])).resolves.toBeUndefined();
      });
    });

    // ── ingestLogs ──────────────────────────────────────────────────────────

    describe("ingestLogs", () => {
      it("stores logs retrievable by queryLogs", async () => {
        const log = makeLog();
        await driver.ingestLogs([log]);

        const result = await driver.queryLogs({ startMs: 0, endMs: 2000 });
        expect(result).toHaveLength(1);
        expect(result[0]!.severity).toBe("ERROR");
        expect(result[0]!.body).toBe("Connection refused");
      });

      it("UPSERT dedup on (service, timestamp, bodyHash) — last write wins", async () => {
        const l1 = makeLog({ severityNumber: 17 });
        const l2 = makeLog({ severityNumber: 21 }); // FATAL
        await driver.ingestLogs([l1]);
        await driver.ingestLogs([l2]);

        const result = await driver.queryLogs({ startMs: 0, endMs: 2000 });
        expect(result).toHaveLength(1);
        expect(result[0]!.severityNumber).toBe(21);
      });

      it("accumulates logs with different keys across calls", async () => {
        const l1 = makeLog({ bodyHash: "hash_aaa" });
        const l2 = makeLog({ bodyHash: "hash_bbb" });
        await driver.ingestLogs([l1]);
        await driver.ingestLogs([l2]);

        const result = await driver.queryLogs({ startMs: 0, endMs: 2000 });
        expect(result).toHaveLength(2);
      });

      it("preserves optional trace correlation fields", async () => {
        const log = makeLog({ traceId: "trace_corr", spanId: "span_corr" });
        await driver.ingestLogs([log]);

        const result = await driver.queryLogs({ startMs: 0, endMs: 2000 });
        expect(result[0]!.traceId).toBe("trace_corr");
        expect(result[0]!.spanId).toBe("span_corr");
      });

      it("handles empty array without error", async () => {
        await expect(driver.ingestLogs([])).resolves.toBeUndefined();
      });
    });

    // ── querySpans ──────────────────────────────────────────────────────────

    describe("querySpans", () => {
      it("filters by time range (startMs/endMs inclusive)", async () => {
        await driver.ingestSpans([
          makeSpan({ spanId: "s1", startTimeMs: 500 }),
          makeSpan({ spanId: "s2", startTimeMs: 1000 }),
          makeSpan({ spanId: "s3", startTimeMs: 1500 }),
          makeSpan({ spanId: "s4", startTimeMs: 2000 }),
        ]);

        const result = await driver.querySpans({ startMs: 1000, endMs: 1500 });
        expect(result).toHaveLength(2);
        const ids = result.map((r) => r.spanId).sort();
        expect(ids).toEqual(["s2", "s3"]);
      });

      it("filters by services array", async () => {
        await driver.ingestSpans([
          makeSpan({ spanId: "s1", serviceName: "web" }),
          makeSpan({ spanId: "s2", serviceName: "api" }),
          makeSpan({ spanId: "s3", serviceName: "db" }),
        ]);

        const result = await driver.querySpans({
          startMs: 0, endMs: 2000,
          services: ["web", "db"],
        });
        expect(result).toHaveLength(2);
        const services = result.map((r) => r.serviceName).sort();
        expect(services).toEqual(["db", "web"]);
      });

      it("filters by environment", async () => {
        await driver.ingestSpans([
          makeSpan({ spanId: "s1", environment: "production" }),
          makeSpan({ spanId: "s2", environment: "staging" }),
        ]);

        const result = await driver.querySpans({
          startMs: 0, endMs: 2000,
          environment: "production",
        });
        expect(result).toHaveLength(1);
        expect(result[0]!.environment).toBe("production");
      });

      it("returns empty for non-matching filter", async () => {
        await driver.ingestSpans([makeSpan()]);

        const result = await driver.querySpans({ startMs: 5000, endMs: 6000 });
        expect(result).toHaveLength(0);
      });

      it("returns empty when no data ingested", async () => {
        const result = await driver.querySpans({ startMs: 0, endMs: 2000 });
        expect(result).toHaveLength(0);
      });
    });

    // ── queryMetrics ────────────────────────────────────────────────────────

    describe("queryMetrics", () => {
      it("filters by time range (startMs/endMs inclusive)", async () => {
        await driver.ingestMetrics([
          makeMetric({ name: "m1", startTimeMs: 500 }),
          makeMetric({ name: "m2", startTimeMs: 1000 }),
          makeMetric({ name: "m3", startTimeMs: 1500 }),
        ]);

        const result = await driver.queryMetrics({ startMs: 1000, endMs: 1500 });
        expect(result).toHaveLength(2);
      });

      it("filters by services array", async () => {
        await driver.ingestMetrics([
          makeMetric({ service: "web", name: "m1" }),
          makeMetric({ service: "api", name: "m2" }),
        ]);

        const result = await driver.queryMetrics({
          startMs: 0, endMs: 2000,
          services: ["api"],
        });
        expect(result).toHaveLength(1);
        expect(result[0]!.service).toBe("api");
      });

      it("filters by environment", async () => {
        await driver.ingestMetrics([
          makeMetric({ environment: "production", name: "m1" }),
          makeMetric({ environment: "staging", name: "m2" }),
        ]);

        const result = await driver.queryMetrics({
          startMs: 0, endMs: 2000,
          environment: "staging",
        });
        expect(result).toHaveLength(1);
        expect(result[0]!.environment).toBe("staging");
      });

      it("returns empty for non-matching filter", async () => {
        await driver.ingestMetrics([makeMetric()]);
        const result = await driver.queryMetrics({ startMs: 5000, endMs: 6000 });
        expect(result).toHaveLength(0);
      });
    });

    // ── queryLogs ───────────────────────────────────────────────────────────

    describe("queryLogs", () => {
      it("filters by time range (startMs/endMs inclusive)", async () => {
        await driver.ingestLogs([
          makeLog({ bodyHash: "h1", startTimeMs: 500 }),
          makeLog({ bodyHash: "h2", startTimeMs: 1000 }),
          makeLog({ bodyHash: "h3", startTimeMs: 2000 }),
        ]);

        const result = await driver.queryLogs({ startMs: 1000, endMs: 1500 });
        expect(result).toHaveLength(1);
        expect(result[0]!.bodyHash).toBe("h2");
      });

      it("filters by services array", async () => {
        await driver.ingestLogs([
          makeLog({ service: "web", bodyHash: "h1" }),
          makeLog({ service: "api", bodyHash: "h2" }),
        ]);

        const result = await driver.queryLogs({
          startMs: 0, endMs: 2000,
          services: ["web"],
        });
        expect(result).toHaveLength(1);
        expect(result[0]!.service).toBe("web");
      });

      it("filters by environment", async () => {
        await driver.ingestLogs([
          makeLog({ environment: "production", bodyHash: "h1" }),
          makeLog({ environment: "staging", bodyHash: "h2" }),
        ]);

        const result = await driver.queryLogs({
          startMs: 0, endMs: 2000,
          environment: "production",
        });
        expect(result).toHaveLength(1);
        expect(result[0]!.environment).toBe("production");
      });

      it("returns empty for non-matching filter", async () => {
        await driver.ingestLogs([makeLog()]);
        const result = await driver.queryLogs({ startMs: 5000, endMs: 6000 });
        expect(result).toHaveLength(0);
      });
    });

    // ── upsertSnapshot ──────────────────────────────────────────────────────

    describe("upsertSnapshot", () => {
      it("creates new snapshot", async () => {
        await driver.upsertSnapshot("inc_001", "traces", [{ traceId: "t1" }]);

        const snapshots = await driver.getSnapshots("inc_001");
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]!.incidentId).toBe("inc_001");
        expect(snapshots[0]!.snapshotType).toBe("traces");
        expect(snapshots[0]!.data).toEqual([{ traceId: "t1" }]);
        expect(snapshots[0]!.updatedAt).toBeDefined();
      });

      it("updates existing snapshot on same (incidentId, type)", async () => {
        await driver.upsertSnapshot("inc_001", "traces", [{ traceId: "t1" }]);
        await driver.upsertSnapshot("inc_001", "traces", [{ traceId: "t2" }, { traceId: "t3" }]);

        const snapshots = await driver.getSnapshots("inc_001");
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]!.data).toEqual([{ traceId: "t2" }, { traceId: "t3" }]);
      });

      it("stores multiple snapshot types per incident", async () => {
        await driver.upsertSnapshot("inc_001", "traces", [{ traceId: "t1" }]);
        await driver.upsertSnapshot("inc_001", "metrics", [{ name: "m1" }]);
        await driver.upsertSnapshot("inc_001", "logs", [{ body: "error" }]);

        const snapshots = await driver.getSnapshots("inc_001");
        expect(snapshots).toHaveLength(3);
        const types = snapshots.map((s) => s.snapshotType).sort();
        expect(types).toEqual(["logs", "metrics", "traces"]);
      });
    });

    // ── getSnapshots ────────────────────────────────────────────────────────

    describe("getSnapshots", () => {
      it("returns all types for incident", async () => {
        await driver.upsertSnapshot("inc_001", "traces", { t: 1 });
        await driver.upsertSnapshot("inc_001", "metrics", { m: 1 });

        const snapshots = await driver.getSnapshots("inc_001");
        expect(snapshots).toHaveLength(2);
      });

      it("returns empty for unknown incidentId", async () => {
        const snapshots = await driver.getSnapshots("inc_unknown");
        expect(snapshots).toHaveLength(0);
      });

      it("does not return snapshots from other incidents", async () => {
        await driver.upsertSnapshot("inc_001", "traces", { t: 1 });
        await driver.upsertSnapshot("inc_002", "traces", { t: 2 });

        const snapshots = await driver.getSnapshots("inc_001");
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]!.data).toEqual({ t: 1 });
      });
    });

    // ── deleteSnapshots ─────────────────────────────────────────────────────

    describe("deleteSnapshots", () => {
      it("removes all snapshots for incident", async () => {
        await driver.upsertSnapshot("inc_001", "traces", { t: 1 });
        await driver.upsertSnapshot("inc_001", "metrics", { m: 1 });
        await driver.upsertSnapshot("inc_001", "logs", { l: 1 });

        await driver.deleteSnapshots("inc_001");

        const snapshots = await driver.getSnapshots("inc_001");
        expect(snapshots).toHaveLength(0);
      });

      it("no-op for unknown incidentId", async () => {
        await expect(driver.deleteSnapshots("inc_unknown")).resolves.toBeUndefined();
      });

      it("does not affect snapshots from other incidents", async () => {
        await driver.upsertSnapshot("inc_001", "traces", { t: 1 });
        await driver.upsertSnapshot("inc_002", "traces", { t: 2 });

        await driver.deleteSnapshots("inc_001");

        const remaining = await driver.getSnapshots("inc_002");
        expect(remaining).toHaveLength(1);
      });
    });

    // ── deleteExpired ────────────────────────────────────────────────────────

    describe("deleteExpired", () => {
      it("removes rows with ingestedAt < cutoff", async () => {
        const oldTime = new Date("2020-01-01T00:00:00Z").getTime();
        const newTime = new Date("2026-03-09T00:00:00Z").getTime();

        await driver.ingestSpans([
          makeSpan({ spanId: "old", ingestedAt: oldTime }),
          makeSpan({ spanId: "new", ingestedAt: newTime }),
        ]);
        await driver.ingestMetrics([
          makeMetric({ name: "old_m", ingestedAt: oldTime }),
          makeMetric({ name: "new_m", ingestedAt: newTime }),
        ]);
        await driver.ingestLogs([
          makeLog({ bodyHash: "old_l", ingestedAt: oldTime }),
          makeLog({ bodyHash: "new_l", ingestedAt: newTime }),
        ]);

        await driver.deleteExpired(new Date("2025-01-01T00:00:00Z"));

        const spans = await driver.querySpans({ startMs: 0, endMs: Number.MAX_SAFE_INTEGER });
        expect(spans).toHaveLength(1);
        expect(spans[0]!.spanId).toBe("new");

        const metrics = await driver.queryMetrics({ startMs: 0, endMs: Number.MAX_SAFE_INTEGER });
        expect(metrics).toHaveLength(1);
        expect(metrics[0]!.name).toBe("new_m");

        const logs = await driver.queryLogs({ startMs: 0, endMs: Number.MAX_SAFE_INTEGER });
        expect(logs).toHaveLength(1);
        expect(logs[0]!.bodyHash).toBe("new_l");
      });

      it("keeps rows with ingestedAt >= cutoff", async () => {
        const time = new Date("2026-03-09T00:00:00Z").getTime();
        await driver.ingestSpans([makeSpan({ ingestedAt: time })]);

        // cutoff exactly at the ingested time — should NOT delete (before is strictly less-than)
        await driver.deleteExpired(new Date("2026-03-09T00:00:00Z"));

        const spans = await driver.querySpans({ startMs: 0, endMs: Number.MAX_SAFE_INTEGER });
        expect(spans).toHaveLength(1);
      });

      it("does not affect snapshots", async () => {
        const oldTime = new Date("2020-01-01T00:00:00Z").getTime();
        await driver.ingestSpans([makeSpan({ ingestedAt: oldTime })]);
        await driver.upsertSnapshot("inc_001", "traces", [{ t: 1 }]);

        await driver.deleteExpired(new Date("2025-01-01T00:00:00Z"));

        // Spans should be deleted
        const spans = await driver.querySpans({ startMs: 0, endMs: Number.MAX_SAFE_INTEGER });
        expect(spans).toHaveLength(0);

        // Snapshots should survive
        const snapshots = await driver.getSnapshots("inc_001");
        expect(snapshots).toHaveLength(1);
      });

      it("no-op when nothing to delete", async () => {
        await expect(driver.deleteExpired(new Date("2020-01-01T00:00:00Z"))).resolves.toBeUndefined();
      });
    });

    // ── deleteExpiredSnapshots ────────────────────────────────────────────────

    describe("deleteExpiredSnapshots", () => {
      it("removes snapshots where updatedAt < cutoff", async () => {
        // upsertSnapshot sets updatedAt to now() internally
        await driver.upsertSnapshot("inc_old", "traces", [{ t: 1 }]);

        // Cutoff far in the future — should delete
        await driver.deleteExpiredSnapshots(new Date("2030-01-01T00:00:00Z"));

        const snapshots = await driver.getSnapshots("inc_old");
        expect(snapshots).toHaveLength(0);
      });

      it("keeps snapshots where updatedAt >= cutoff", async () => {
        await driver.upsertSnapshot("inc_new", "traces", [{ t: 1 }]);

        // Cutoff in the past — should NOT delete
        await driver.deleteExpiredSnapshots(new Date("2020-01-01T00:00:00Z"));

        const snapshots = await driver.getSnapshots("inc_new");
        expect(snapshots).toHaveLength(1);
      });

      it("no-op when nothing to delete", async () => {
        await expect(
          driver.deleteExpiredSnapshots(new Date("2020-01-01T00:00:00Z")),
        ).resolves.toBeUndefined();
      });

      it("does not affect raw telemetry data", async () => {
        const time = new Date("2026-03-09T00:00:00Z").getTime();
        await driver.ingestSpans([makeSpan({ ingestedAt: time })]);
        await driver.upsertSnapshot("inc_snap", "traces", [{ t: 1 }]);

        // Delete all snapshots but not spans
        await driver.deleteExpiredSnapshots(new Date("2030-01-01T00:00:00Z"));

        const snapshots = await driver.getSnapshots("inc_snap");
        expect(snapshots).toHaveLength(0);

        const spans = await driver.querySpans({ startMs: 0, endMs: Number.MAX_SAFE_INTEGER });
        expect(spans).toHaveLength(1);
      });
    });
  });
}
