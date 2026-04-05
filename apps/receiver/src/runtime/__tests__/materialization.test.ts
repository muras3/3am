import { describe, it, expect, vi, beforeEach } from "vitest";
import { ensureIncidentMaterialized } from "../materialization.js";
import type { StorageDriver, Incident } from "../../storage/interface.js";
import type { TelemetryStoreDriver, EvidenceSnapshot } from "../../telemetry/interface.js";
import type { DiagnosisRunner } from "../diagnosis-runner.js";

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeIncident(overrides: Partial<Incident> = {}): Incident {
  return {
    incidentId: "inc_1",
    status: "open",
    openedAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T01:00:00Z",
    packet: { generation: 5 } as unknown as Incident["packet"],
    telemetryScope: {
      windowStartMs: 0,
      windowEndMs: 1,
      detectTimeMs: 0,
      environment: "test",
      memberServices: [],
      dependencyServices: [],
    },
    spanMembership: [],
    anomalousSignals: [],
    platformEvents: [],
    ...overrides,
  };
}

function makeSnapshot(updatedAt: string): EvidenceSnapshot {
  return {
    incidentId: "inc_1",
    snapshotType: "traces",
    data: [],
    updatedAt,
  };
}

function createMockStorage(incident: Incident | null = makeIncident()): StorageDriver & {
  getIncident: ReturnType<typeof vi.fn>;
  claimMaterializationLease: ReturnType<typeof vi.fn>;
  releaseMaterializationLease: ReturnType<typeof vi.fn>;
} {
  return {
    getIncident: vi.fn().mockResolvedValue(incident),
    claimMaterializationLease: vi.fn().mockResolvedValue(true),
    releaseMaterializationLease: vi.fn().mockResolvedValue(undefined),
    claimDiagnosisDispatch: vi.fn().mockResolvedValue(true),
    releaseDiagnosisDispatch: vi.fn().mockResolvedValue(undefined),
    markDiagnosisScheduled: vi.fn().mockResolvedValue(undefined),
    clearDiagnosisScheduled: vi.fn().mockResolvedValue(undefined),
    createIncident: vi.fn(),
    updatePacket: vi.fn(),
    updateIncidentStatus: vi.fn(),
    touchIncidentActivity: vi.fn(),
    appendDiagnosis: vi.fn(),
    appendConsoleNarrative: vi.fn(),
    listIncidents: vi.fn(),
    getIncidentByPacketId: vi.fn(),
    deleteExpiredIncidents: vi.fn(),
    expandTelemetryScope: vi.fn(),
    appendSpanMembership: vi.fn(),
    appendAnomalousSignals: vi.fn(),
    appendPlatformEvents: vi.fn(),
    nextIncidentSequence: vi.fn(),
    saveThinEvent: vi.fn(),
    listThinEvents: vi.fn(),
    getSettings: vi.fn(),
    setSettings: vi.fn(),
  } as unknown as StorageDriver & {
    getIncident: ReturnType<typeof vi.fn>;
    claimMaterializationLease: ReturnType<typeof vi.fn>;
    releaseMaterializationLease: ReturnType<typeof vi.fn>;
  };
}

function createMockTelemetryStore(snapshots: EvidenceSnapshot[] = []): TelemetryStoreDriver & {
  getSnapshots: ReturnType<typeof vi.fn>;
} {
  return {
    getSnapshots: vi.fn().mockResolvedValue(snapshots),
    upsertSnapshot: vi.fn().mockResolvedValue(undefined),
    deleteSnapshots: vi.fn(),
    ingestSpans: vi.fn(),
    ingestMetrics: vi.fn(),
    ingestLogs: vi.fn(),
    querySpans: vi.fn().mockResolvedValue([]),
    queryMetrics: vi.fn().mockResolvedValue([]),
    queryLogs: vi.fn().mockResolvedValue([]),
    deleteExpired: vi.fn(),
    deleteExpiredSnapshots: vi.fn(),
  } as unknown as TelemetryStoreDriver & {
    getSnapshots: ReturnType<typeof vi.fn>;
  };
}

// Mock rebuildSnapshots — it's heavy and tested separately
vi.mock("../../telemetry/snapshot-builder.js", () => ({
  rebuildSnapshots: vi.fn().mockResolvedValue(undefined),
}));

// Import the mock after vi.mock so we can inspect calls
import { rebuildSnapshots } from "../../telemetry/snapshot-builder.js";
const mockRebuildSnapshots = vi.mocked(rebuildSnapshots);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ensureIncidentMaterialized", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Freshness detection ──

  it("rebuilds when snapshots are exactly equal to lastActivityAt (equal means potentially stale)", async () => {
    const incident = makeIncident({ lastActivityAt: "2026-01-01T01:00:00Z" });
    const storage = createMockStorage(incident);
    const telemetry = createMockTelemetryStore([
      makeSnapshot("2026-01-01T01:00:00Z"), // exactly equal → stale (new data may exist)
    ]);

    const result = await ensureIncidentMaterialized("inc_1", storage, telemetry);

    expect(result).toBe(true);
    expect(storage.claimMaterializationLease).toHaveBeenCalledWith("inc_1");
    expect(mockRebuildSnapshots).toHaveBeenCalled();
  });

  it("skips rebuild when snapshots are newer than lastActivityAt", async () => {
    const incident = makeIncident({ lastActivityAt: "2026-01-01T01:00:00Z" });
    const storage = createMockStorage(incident);
    const telemetry = createMockTelemetryStore([
      makeSnapshot("2026-01-01T02:00:00Z"), // newer → fresh
    ]);

    const result = await ensureIncidentMaterialized("inc_1", storage, telemetry);

    expect(result).toBe(false);
    expect(mockRebuildSnapshots).not.toHaveBeenCalled();
  });

  it("rebuilds when snapshots are stale (updatedAt < lastActivityAt)", async () => {
    const incident = makeIncident({ lastActivityAt: "2026-01-01T01:00:00Z" });
    const storage = createMockStorage(incident);
    const telemetry = createMockTelemetryStore([
      makeSnapshot("2026-01-01T00:30:00Z"), // older → stale
    ]);

    const result = await ensureIncidentMaterialized("inc_1", storage, telemetry);

    expect(result).toBe(true);
    expect(storage.claimMaterializationLease).toHaveBeenCalledWith("inc_1");
    expect(mockRebuildSnapshots).toHaveBeenCalledWith("inc_1", telemetry, storage);
    expect(storage.releaseMaterializationLease).toHaveBeenCalledWith("inc_1");
  });

  it("rebuilds when no snapshots exist (first materialization)", async () => {
    const storage = createMockStorage();
    const telemetry = createMockTelemetryStore([]); // no snapshots

    const result = await ensureIncidentMaterialized("inc_1", storage, telemetry);

    expect(result).toBe(true);
    expect(mockRebuildSnapshots).toHaveBeenCalledWith("inc_1", telemetry, storage);
  });

  it("uses the latest snapshot timestamp when multiple snapshots exist", async () => {
    const incident = makeIncident({ lastActivityAt: "2026-01-01T01:00:00Z" });
    const storage = createMockStorage(incident);
    const telemetry = createMockTelemetryStore([
      makeSnapshot("2026-01-01T00:30:00Z"), // stale
      makeSnapshot("2026-01-01T01:30:00Z"), // fresh — this one wins
      makeSnapshot("2026-01-01T00:45:00Z"), // stale
    ]);

    const result = await ensureIncidentMaterialized("inc_1", storage, telemetry);

    expect(result).toBe(false); // latest snapshot is fresh
    expect(mockRebuildSnapshots).not.toHaveBeenCalled();
  });

  // ── Incident not found ──

  it("returns false when incident does not exist", async () => {
    const storage = createMockStorage(null);
    const telemetry = createMockTelemetryStore();

    const result = await ensureIncidentMaterialized("inc_999", storage, telemetry);

    expect(result).toBe(false);
    expect(telemetry.getSnapshots).not.toHaveBeenCalled();
  });

  // ── Lease concurrency ──

  it("skips rebuild when lease is already held by another reader", async () => {
    const incident = makeIncident({ lastActivityAt: "2026-01-01T01:00:00Z" });
    const storage = createMockStorage(incident);
    storage.claimMaterializationLease.mockResolvedValue(false); // lease already held
    const telemetry = createMockTelemetryStore([
      makeSnapshot("2026-01-01T00:30:00Z"), // stale
    ]);

    const result = await ensureIncidentMaterialized("inc_1", storage, telemetry);

    expect(result).toBe(false);
    expect(storage.claimMaterializationLease).toHaveBeenCalledWith("inc_1");
    expect(mockRebuildSnapshots).not.toHaveBeenCalled();
    expect(storage.releaseMaterializationLease).not.toHaveBeenCalled();
  });

  // ── Lease release on error ──

  it("returns false and releases lease when rebuildSnapshots throws (graceful degradation)", async () => {
    const incident = makeIncident({ lastActivityAt: "2026-01-01T01:00:00Z" });
    const storage = createMockStorage(incident);
    const telemetry = createMockTelemetryStore([
      makeSnapshot("2026-01-01T00:30:00Z"),
    ]);
    mockRebuildSnapshots.mockRejectedValueOnce(new Error("DB connection failed"));

    const result = await ensureIncidentMaterialized("inc_1", storage, telemetry);

    expect(result).toBe(false);
    expect(storage.releaseMaterializationLease).toHaveBeenCalledWith("inc_1");
  });

  // ── Diagnosis threshold ──

  it("calls checkGenerationThreshold after successful rebuild when config provided", async () => {
    const incident = makeIncident({
      lastActivityAt: "2026-01-01T01:00:00Z",
      packet: { generation: 10 } as unknown as Incident["packet"],
    });
    const storage = createMockStorage(incident);
    // getIncident is called twice: once at start, once after rebuild for threshold check
    storage.getIncident.mockResolvedValue(incident);
    const telemetry = createMockTelemetryStore([
      makeSnapshot("2026-01-01T00:30:00Z"),
    ]);
    const runner = { run: vi.fn() } as unknown as DiagnosisRunner;

    const result = await ensureIncidentMaterialized(
      "inc_1",
      storage,
      telemetry,
      { generationThreshold: 5 },
      runner,
    );

    expect(result).toBe(true);
    // getIncident called at least twice: initial check + post-rebuild threshold check
    // (checkGenerationThreshold may internally call getIncident again)
    expect(storage.getIncident).toHaveBeenCalledTimes(3);
  });

  it("does not call checkGenerationThreshold when diagnosisConfig is not provided", async () => {
    const incident = makeIncident({ lastActivityAt: "2026-01-01T01:00:00Z" });
    const storage = createMockStorage(incident);
    const telemetry = createMockTelemetryStore([
      makeSnapshot("2026-01-01T00:30:00Z"),
    ]);

    await ensureIncidentMaterialized("inc_1", storage, telemetry);

    // getIncident called only once (initial check), not for threshold
    expect(storage.getIncident).toHaveBeenCalledTimes(1);
  });

  it("does not call checkGenerationThreshold when generationThreshold is 0", async () => {
    const incident = makeIncident({ lastActivityAt: "2026-01-01T01:00:00Z" });
    const storage = createMockStorage(incident);
    const telemetry = createMockTelemetryStore([
      makeSnapshot("2026-01-01T00:30:00Z"),
    ]);

    await ensureIncidentMaterialized(
      "inc_1",
      storage,
      telemetry,
      { generationThreshold: 0 },
    );

    expect(storage.getIncident).toHaveBeenCalledTimes(1);
  });
});
