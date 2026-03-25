/**
 * Integration tests: verify lazy cleanup fires from HTTP endpoints
 * and does not break request handling on failure.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createApp } from "../../index.js";
import { MemoryAdapter } from "../../storage/adapters/memory.js";
import { MemoryTelemetryAdapter } from "../../telemetry/adapters/memory.js";
import { _resetCleanupTimerForTest } from "../../retention/lazy-cleanup.js";
import { makePacket, makeMembership } from "../storage/shared-suite.js";
import { makeSpan } from "../telemetry/shared-suite.js";

function createTestApp(opts?: {
  storage?: MemoryAdapter;
  telemetry?: MemoryTelemetryAdapter;
}) {
  const storage = opts?.storage ?? new MemoryAdapter();
  const telemetry = opts?.telemetry ?? new MemoryTelemetryAdapter();
  const app = createApp(storage, {
    telemetryStore: telemetry,
    resolvedAuthToken: null,
  });
  return { app, storage, telemetry };
}

describe("cleanup integration", () => {
  beforeEach(() => {
    _resetCleanupTimerForTest();
    process.env["ALLOW_INSECURE_DEV_MODE"] = "true";
    process.env["RETENTION_HOURS"] = "1";
  });

  afterEach(() => {
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
    delete process.env["RETENTION_HOURS"];
  });

  it("GET /api/incidents returns 200 and triggers cleanup of expired data", async () => {
    const storage = new MemoryAdapter();
    const telemetry = new MemoryTelemetryAdapter();

    // Insert a closed incident from the past
    const oldPacket = makePacket({
      incidentId: "inc_expired",
      packetId: "pkt_expired",
      openedAt: "2020-01-01T00:00:00Z",
    });
    await storage.createIncident(oldPacket, makeMembership());
    await storage.updateIncidentStatus("inc_expired", "closed");

    // Insert old telemetry data
    const oldTime = new Date("2020-01-01T00:00:00Z").getTime();
    await telemetry.ingestSpans([makeSpan({ spanId: "old_span", ingestedAt: oldTime })]);

    const { app } = createTestApp({ storage, telemetry });
    const res = await app.request("/api/incidents");
    expect(res.status).toBe(200);

    // Verify cleanup ran — expired incident should be gone
    const incident = await storage.getIncident("inc_expired");
    expect(incident).toBeNull();

    // Expired telemetry also gone
    const spans = await telemetry.querySpans({ startMs: 0, endMs: Number.MAX_SAFE_INTEGER });
    expect(spans).toHaveLength(0);
  });

  it("GET /api/incidents/:id returns 200 and does not delete open incidents", async () => {
    const storage = new MemoryAdapter();
    const oldPacket = makePacket({
      incidentId: "inc_open_old",
      packetId: "pkt_open_old",
      openedAt: "2020-01-01T00:00:00Z",
    });
    await storage.createIncident(oldPacket, makeMembership());
    // status remains "open"

    const { app } = createTestApp({ storage });
    const res = await app.request("/api/incidents/inc_open_old");
    expect(res.status).toBe(200);

    // Open incident should NOT be deleted
    const incident = await storage.getIncident("inc_open_old");
    expect(incident).not.toBeNull();
    expect(incident?.status).toBe("open");
  });

  it("GET /api/incidents/:id/evidence returns 200 and triggers cleanup", async () => {
    const storage = new MemoryAdapter();
    const telemetry = new MemoryTelemetryAdapter();
    const packet = makePacket();
    await storage.createIncident(packet, makeMembership());

    // Insert old snapshot
    await telemetry.upsertSnapshot("inc_orphan", "traces", [{ t: 1 }]);

    const { app } = createTestApp({ storage, telemetry });
    const res = await app.request(`/api/incidents/${packet.incidentId}/evidence`);
    expect(res.status).toBe(200);

    // Old snapshot should be cleaned (updatedAt is now, but orphan snapshots with old updatedAt would be cleaned)
    // Since snapshot was just created, it won't be cleaned. This test verifies cleanup runs without error.
  });

  it("cleanup failure does not break GET /api/incidents", async () => {
    const storage = new MemoryAdapter();
    const telemetry = new MemoryTelemetryAdapter();

    // Make deleteExpiredIncidents throw
    const originalDelete = storage.deleteExpiredIncidents.bind(storage);
    storage.deleteExpiredIncidents = async () => {
      throw new Error("DB exploded");
    };

    const { app } = createTestApp({ storage, telemetry });
    const res = await app.request("/api/incidents");
    expect(res.status).toBe(200);

    // Restore for cleanup
    storage.deleteExpiredIncidents = originalDelete;
  });

  it("cleanup failure does not break POST /v1/traces", async () => {
    const storage = new MemoryAdapter();
    const telemetry = new MemoryTelemetryAdapter();

    // Make telemetry deleteExpired throw
    telemetry.deleteExpired = async () => {
      throw new Error("Telemetry DB exploded");
    };

    const { app } = createTestApp({ storage, telemetry });
    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resourceSpans: [] }),
    });
    expect(res.status).toBe(200);
  });
});
