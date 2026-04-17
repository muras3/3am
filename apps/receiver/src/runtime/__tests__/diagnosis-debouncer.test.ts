import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  scheduleDelayedDiagnosis,
  checkGenerationThreshold,
  runIfNeeded,
  recoverOrphanedDiagnoses,
  _resetInFlightForTest,
  _resetOrphanCheckForTest,
  ORPHAN_SCHEDULED_THRESHOLD_MS,
  ORPHAN_CHECK_INTERVAL_MS,
} from "../diagnosis-debouncer.js";
import type { StorageDriver } from "../../storage/interface.js";
import type { DiagnosisRunner } from "../diagnosis-runner.js";
import { DEFAULT_DIAGNOSIS_LEASE_MS } from "../diagnosis-dispatch.js";

function createMockStorage(incident?: { diagnosisResult?: unknown }): StorageDriver {
  return {
    getIncident: vi.fn().mockResolvedValue(
      incident !== undefined
        ? { incidentId: "inc_1", diagnosisResult: incident.diagnosisResult, packet: { generation: 1 } }
        : null,
    ),
    claimDiagnosisDispatch: vi.fn().mockResolvedValue(true),
    releaseDiagnosisDispatch: vi.fn().mockResolvedValue(undefined),
    markDiagnosisScheduled: vi.fn().mockResolvedValue(undefined),
    clearDiagnosisScheduled: vi.fn().mockResolvedValue(undefined),
    createIncident: vi.fn(),
    updatePacket: vi.fn(),
    updateIncidentStatus: vi.fn(),
    appendDiagnosis: vi.fn(),
    listIncidents: vi.fn(),
    getIncidentByPacketId: vi.fn(),
    deleteExpiredIncidents: vi.fn(),
    expandTelemetryScope: vi.fn(),
    appendSpanMembership: vi.fn(),
    appendAnomalousSignals: vi.fn(),
    appendPlatformEvents: vi.fn(),
    saveThinEvent: vi.fn(),
    listThinEvents: vi.fn(),
    getSettings: vi.fn(),
    setSettings: vi.fn(),
  } as unknown as StorageDriver;
}

function createMockRunner(): DiagnosisRunner & { run: ReturnType<typeof vi.fn> } {
  return { run: vi.fn().mockResolvedValue(true) } as unknown as DiagnosisRunner & { run: ReturnType<typeof vi.fn> };
}

describe("scheduleDelayedDiagnosis", () => {
  beforeEach(() => { vi.useFakeTimers(); _resetInFlightForTest(); });
  afterEach(() => { vi.useRealTimers(); });

  it("calls runner.run after maxWaitMs when no diagnosis exists", async () => {
    const storage = createMockStorage({ diagnosisResult: undefined });
    const runner = createMockRunner();
    const waitUntilFn = vi.fn((p: Promise<unknown>) => { void p; });

    scheduleDelayedDiagnosis("inc_1", storage, runner, { maxWaitMs: 10_000 }, waitUntilFn);

    // Let the async work() wrapper resolve
    await vi.advanceTimersByTimeAsync(0);
    expect(waitUntilFn).toHaveBeenCalledTimes(1);

    // Advance past the sleep
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runner.run).toHaveBeenCalledWith("inc_1");
  });

  it("skips runner.run if diagnosis already exists", async () => {
    const storage = createMockStorage({ diagnosisResult: { summary: "done" } });
    const runner = createMockRunner();
    const waitUntilFn = vi.fn((p: Promise<unknown>) => { void p; });

    scheduleDelayedDiagnosis("inc_1", storage, runner, { maxWaitMs: 5_000 }, waitUntilFn);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("skips runner.run if incident not found", async () => {
    const storage = createMockStorage(undefined); // getIncident returns null
    const runner = createMockRunner();
    const waitUntilFn = vi.fn((p: Promise<unknown>) => { void p; });

    scheduleDelayedDiagnosis("inc_missing", storage, runner, { maxWaitMs: 5_000 }, waitUntilFn);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runner.run).not.toHaveBeenCalled();
  });
});

describe("checkGenerationThreshold", () => {
  it("calls runner.run when generation meets threshold and no diagnosis exists", async () => {
    const storage = createMockStorage({ diagnosisResult: undefined });
    const runner = createMockRunner();

    checkGenerationThreshold("inc_1", 50, storage, runner, { generationThreshold: 50 });

    // runIfNeeded is async, give it a tick
    await vi.waitFor(() => {
      expect(runner.run).toHaveBeenCalledWith("inc_1");
    });
  });

  it("does not call runner.run below threshold", () => {
    const storage = createMockStorage({ diagnosisResult: undefined });
    const runner = createMockRunner();

    checkGenerationThreshold("inc_1", 49, storage, runner, { generationThreshold: 50 });

    expect(runner.run).not.toHaveBeenCalled();
    expect(storage.getIncident).not.toHaveBeenCalled();
  });

  it("does not call runner.run when threshold is 0 (disabled)", () => {
    const storage = createMockStorage({ diagnosisResult: undefined });
    const runner = createMockRunner();

    checkGenerationThreshold("inc_1", 100, storage, runner, { generationThreshold: 0 });

    expect(runner.run).not.toHaveBeenCalled();
  });

  it("skips runner.run if diagnosis already exists", async () => {
    const storage = createMockStorage({ diagnosisResult: { summary: "already done" } });
    const runner = createMockRunner();

    checkGenerationThreshold("inc_1", 50, storage, runner, { generationThreshold: 50 });

    // Give the async runIfNeeded time to resolve
    await new Promise((r) => setTimeout(r, 0));
    expect(runner.run).not.toHaveBeenCalled();
  });
});

describe("in-flight guard (race condition prevention)", () => {
  beforeEach(() => { vi.useFakeTimers(); _resetInFlightForTest(); });
  afterEach(() => { vi.useRealTimers(); });

  it("prevents duplicate runner.run when delayed and threshold paths race", async () => {
    // runner.run() takes some time — simulate with a deferred promise
    let resolveRun!: () => void;
    const runPromise = new Promise<boolean>((r) => { resolveRun = () => r(true); });
    const runner = createMockRunner();
    runner.run.mockReturnValue(runPromise);

    const storage = createMockStorage({ diagnosisResult: undefined });
    const waitUntilFn = vi.fn((p: Promise<unknown>) => { void p; });

    // Schedule delayed diagnosis (will fire after 5s)
    scheduleDelayedDiagnosis("inc_1", storage, runner, { maxWaitMs: 5_000 }, waitUntilFn);

    // Advance past the sleep — delayed path enters runIfNeeded, starts runner.run
    await vi.advanceTimersByTimeAsync(5_000);

    // Now the delayed path has called runner.run() and it's in-flight.
    // Concurrently, the generation threshold path tries to fire for the same incident.
    checkGenerationThreshold("inc_1", 50, storage, runner, { generationThreshold: 50 });

    // Give async a tick to process
    await vi.advanceTimersByTimeAsync(0);

    // runner.run should have been called exactly once (the delayed path).
    // The threshold path should have been blocked by the in-flight guard.
    expect(runner.run).toHaveBeenCalledTimes(1);

    // Complete the in-flight run
    resolveRun();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("allows runner.run for same incident after previous run completes", async () => {
    const storage = createMockStorage({ diagnosisResult: undefined });
    const runner = createMockRunner();
    const waitUntilFn = vi.fn((p: Promise<unknown>) => { void p; });

    // First run via delayed diagnosis
    scheduleDelayedDiagnosis("inc_1", storage, runner, { maxWaitMs: 1_000 }, waitUntilFn);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runner.run).toHaveBeenCalledTimes(1);

    // After completion, in-flight guard should be cleared.
    // A new threshold check should be able to fire.
    checkGenerationThreshold("inc_1", 50, storage, runner, { generationThreshold: 50 });
    await vi.advanceTimersByTimeAsync(0);

    expect(runner.run).toHaveBeenCalledTimes(2);
  });

  it("cleans up in-flight guard even when runner.run throws", async () => {
    const storage = createMockStorage({ diagnosisResult: undefined });
    const runner = createMockRunner();
    runner.run.mockRejectedValueOnce(new Error("LLM failed"));
    const waitUntilFn = vi.fn((p: Promise<unknown>) => { void p; });

    // First run fails
    scheduleDelayedDiagnosis("inc_1", storage, runner, { maxWaitMs: 1_000 }, waitUntilFn);
    await vi.advanceTimersByTimeAsync(1_000);
    // Give the rejection a tick to settle
    await vi.advanceTimersByTimeAsync(0);

    expect(runner.run).toHaveBeenCalledTimes(1);

    // After failure, in-flight guard should be cleared (finally block).
    // A retry via threshold check should proceed.
    runner.run.mockResolvedValue(true);
    checkGenerationThreshold("inc_1", 50, storage, runner, { generationThreshold: 50 });
    await vi.advanceTimersByTimeAsync(0);

    expect(runner.run).toHaveBeenCalledTimes(2);
  });

  it("allows concurrent runs for different incidents", async () => {
    let resolveRun1!: () => void;
    const runPromise1 = new Promise<boolean>((r) => { resolveRun1 = () => r(true); });
    const runner = createMockRunner();
    runner.run.mockReturnValueOnce(runPromise1).mockResolvedValue(true);

    const storage1 = createMockStorage({ diagnosisResult: undefined });
    const storage2 = createMockStorage({ diagnosisResult: undefined });
    const waitUntilFn = vi.fn((p: Promise<unknown>) => { void p; });

    // Start run for inc_1
    scheduleDelayedDiagnosis("inc_1", storage1, runner, { maxWaitMs: 1_000 }, waitUntilFn);
    await vi.advanceTimersByTimeAsync(1_000);

    // inc_1 is in-flight. inc_2 should still be allowed.
    checkGenerationThreshold("inc_2", 50, storage2, runner, { generationThreshold: 50 });
    await vi.advanceTimersByTimeAsync(0);

    // Both incidents should have had runner.run called
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(runner.run).toHaveBeenCalledWith("inc_1");
    expect(runner.run).toHaveBeenCalledWith("inc_2");

    resolveRun1();
    await vi.advanceTimersByTimeAsync(0);
  });
});

describe("DB-level dispatch guard (cross-instance idempotency)", () => {
  beforeEach(() => { vi.useFakeTimers(); _resetInFlightForTest(); });
  afterEach(() => { vi.useRealTimers(); });

  it("skips runner.run when claimDiagnosisDispatch returns false", async () => {
    const storage = createMockStorage({ diagnosisResult: undefined });
    (storage.claimDiagnosisDispatch as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const runner = createMockRunner();

    checkGenerationThreshold("inc_1", 50, storage, runner, { generationThreshold: 50 });
    await vi.advanceTimersByTimeAsync(0);

    expect(storage.claimDiagnosisDispatch).toHaveBeenCalledWith("inc_1", expect.any(Number));
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("calls runner.run when claimDiagnosisDispatch returns true", async () => {
    const storage = createMockStorage({ diagnosisResult: undefined });
    (storage.claimDiagnosisDispatch as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const runner = createMockRunner();

    checkGenerationThreshold("inc_1", 50, storage, runner, { generationThreshold: 50 });
    await vi.advanceTimersByTimeAsync(0);

    expect(storage.claimDiagnosisDispatch).toHaveBeenCalledWith("inc_1", expect.any(Number));
    expect(runner.run).toHaveBeenCalledWith("inc_1");
  });

  it("does not call claimDiagnosisDispatch when diagnosis already exists", async () => {
    const storage = createMockStorage({ diagnosisResult: { summary: "done" } });
    const runner = createMockRunner();

    checkGenerationThreshold("inc_1", 50, storage, runner, { generationThreshold: 50 });
    await vi.advanceTimersByTimeAsync(0);

    expect(storage.claimDiagnosisDispatch).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
  });
});

describe("claim release on diagnosis failure", () => {
  beforeEach(() => { _resetInFlightForTest(); });

  it("releases dispatch claim when runner.run throws", async () => {
    const storage = createMockStorage({ diagnosisResult: undefined });
    const runner = createMockRunner();
    runner.run.mockRejectedValueOnce(new Error("ANTHROPIC_API_KEY missing"));

    await expect(runIfNeeded("inc_1", storage, runner)).rejects.toThrow("ANTHROPIC_API_KEY missing");

    expect(storage.claimDiagnosisDispatch).toHaveBeenCalledWith("inc_1", expect.any(Number));
    expect(storage.releaseDiagnosisDispatch).toHaveBeenCalledWith("inc_1");
  });

  it("allows re-claim after release (incident becomes retryable)", async () => {
    const storage = createMockStorage({ diagnosisResult: undefined });
    const runner = createMockRunner();
    runner.run.mockRejectedValueOnce(new Error("LLM timeout"));

    await expect(runIfNeeded("inc_1", storage, runner)).rejects.toThrow("LLM timeout");
    expect(storage.releaseDiagnosisDispatch).toHaveBeenCalledWith("inc_1");

    // After release, claimDiagnosisDispatch should succeed again
    runner.run.mockResolvedValue(true);
    await runIfNeeded("inc_1", storage, runner);
    expect(runner.run).toHaveBeenCalledTimes(2);
  });

  it("releases claim after runner.run succeeds so pending can resolve back to ready", async () => {
    const storage = createMockStorage({ diagnosisResult: undefined });
    const runner = createMockRunner();

    await runIfNeeded("inc_1", storage, runner);

    expect(storage.releaseDiagnosisDispatch).toHaveBeenCalledWith("inc_1");
    expect(runner.run).toHaveBeenCalledWith("inc_1");
  });

  it("releases dispatch claim when runner.run returns false (silent failure)", async () => {
    const storage = createMockStorage({ diagnosisResult: undefined });
    const runner = createMockRunner();
    runner.run.mockResolvedValueOnce(false);

    await runIfNeeded("inc_1", storage, runner);

    expect(storage.claimDiagnosisDispatch).toHaveBeenCalledWith("inc_1", expect.any(Number));
    expect(storage.releaseDiagnosisDispatch).toHaveBeenCalledWith("inc_1");
  });

  it("allows re-claim after silent failure (runner.run returns false)", async () => {
    const storage = createMockStorage({ diagnosisResult: undefined });
    const runner = createMockRunner();
    runner.run.mockResolvedValueOnce(false);

    await runIfNeeded("inc_1", storage, runner);
    expect(storage.releaseDiagnosisDispatch).toHaveBeenCalledWith("inc_1");

    // After release, a retry should proceed
    runner.run.mockResolvedValue(true);
    await runIfNeeded("inc_1", storage, runner);
    expect(runner.run).toHaveBeenCalledTimes(2);
  });
});

describe("runIfNeeded (exported for immediate path)", () => {
  beforeEach(() => { _resetInFlightForTest(); });

  it("goes through claim protocol", async () => {
    const storage = createMockStorage({ diagnosisResult: undefined });
    const runner = createMockRunner();

    await runIfNeeded("inc_1", storage, runner);

    expect(storage.getIncident).toHaveBeenCalledWith("inc_1");
    expect(storage.claimDiagnosisDispatch).toHaveBeenCalledWith("inc_1", expect.any(Number));
    expect(runner.run).toHaveBeenCalledWith("inc_1");
  });

  it("skips when claim is already taken", async () => {
    const storage = createMockStorage({ diagnosisResult: undefined });
    (storage.claimDiagnosisDispatch as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const runner = createMockRunner();

    await runIfNeeded("inc_1", storage, runner);

    expect(runner.run).not.toHaveBeenCalled();
  });
});

// ── Orphan recovery ──────────────────────────────────────────────────────────

/**
 * Build a mock incident for orphan recovery tests.
 * @param opts.scheduledMsAgo - How many ms ago diagnosis_scheduled_at was set.
 * @param opts.diagnosisResult - If set, incident already has a result.
 * @param opts.dispatchedMsAgo - If set, diagnosis_dispatched_at was set this many ms ago.
 */
function makeOrphanIncident(opts: {
  scheduledMsAgo: number;
  diagnosisResult?: unknown;
  dispatchedMsAgo?: number;
  incidentId?: string;
}, now = Date.now()) {
  const scheduledAt = new Date(now - opts.scheduledMsAgo).toISOString();
  const dispatchedAt = opts.dispatchedMsAgo !== undefined
    ? new Date(now - opts.dispatchedMsAgo).toISOString()
    : undefined;
  return {
    incidentId: opts.incidentId ?? "inc_orphan",
    diagnosisScheduledAt: scheduledAt,
    diagnosisDispatchedAt: dispatchedAt,
    diagnosisResult: opts.diagnosisResult ?? undefined,
    packet: { generation: 1 },
    status: "open",
  };
}

function createMockStorageWithIncidents(incidents: ReturnType<typeof makeOrphanIncident>[]): StorageDriver {
  return {
    getIncident: vi.fn().mockImplementation((id: string) => {
      const found = incidents.find((i) => i.incidentId === id) ?? null;
      return Promise.resolve(found);
    }),
    listIncidents: vi.fn().mockResolvedValue({ items: incidents }),
    claimDiagnosisDispatch: vi.fn().mockResolvedValue(true),
    releaseDiagnosisDispatch: vi.fn().mockResolvedValue(undefined),
    markDiagnosisScheduled: vi.fn().mockResolvedValue(undefined),
    clearDiagnosisScheduled: vi.fn().mockResolvedValue(undefined),
    createIncident: vi.fn(),
    updatePacket: vi.fn(),
    updateIncidentStatus: vi.fn(),
    appendDiagnosis: vi.fn(),
    getIncidentByPacketId: vi.fn(),
    deleteExpiredIncidents: vi.fn(),
    expandTelemetryScope: vi.fn(),
    appendSpanMembership: vi.fn(),
    appendAnomalousSignals: vi.fn(),
    appendPlatformEvents: vi.fn(),
    appendConsoleNarrative: vi.fn(),
    updateNotificationState: vi.fn(),
    claimMaterializationLease: vi.fn(),
    releaseMaterializationLease: vi.fn(),
    nextIncidentSequence: vi.fn(),
    touchIncidentActivity: vi.fn(),
    saveThinEvent: vi.fn(),
    listThinEvents: vi.fn(),
    getSettings: vi.fn(),
    setSettings: vi.fn(),
    consumeRateLimit: vi.fn(),
  } as unknown as StorageDriver;
}

describe("recoverOrphanedDiagnoses", () => {
  beforeEach(() => {
    _resetInFlightForTest();
    _resetOrphanCheckForTest();
  });

  it("recovers orphan with scheduledAt older than threshold and no result", async () => {
    const now = Date.now();
    const orphan = makeOrphanIncident({ scheduledMsAgo: ORPHAN_SCHEDULED_THRESHOLD_MS + 1_000 }, now);
    const storage = createMockStorageWithIncidents([orphan]);
    const runner = createMockRunner();
    const waitUntilFn = vi.fn((p: Promise<unknown>) => { void p; });

    recoverOrphanedDiagnoses(storage, runner, waitUntilFn, now);

    // waitUntil should have been called with the recovery promise
    expect(waitUntilFn).toHaveBeenCalledTimes(1);

    // Flush the async work inside waitUntil
    await vi.waitFor(() => {
      expect(runner.run).toHaveBeenCalledWith("inc_orphan");
    });
  });

  it("does NOT recover incident with scheduledAt newer than threshold (timer may still be alive)", async () => {
    const now = Date.now();
    // 10s ago — well within the 45s window
    const recent = makeOrphanIncident({ scheduledMsAgo: 10_000 }, now);
    const storage = createMockStorageWithIncidents([recent]);
    const runner = createMockRunner();
    const waitUntilFn = vi.fn((p: Promise<unknown>) => { void p; });

    recoverOrphanedDiagnoses(storage, runner, waitUntilFn, now);
    await vi.waitFor(() => expect(storage.listIncidents).toHaveBeenCalled());

    expect(runner.run).not.toHaveBeenCalled();
  });

  it("does NOT recover incident that already has a diagnosisResult", async () => {
    const now = Date.now();
    const done = makeOrphanIncident({
      scheduledMsAgo: ORPHAN_SCHEDULED_THRESHOLD_MS + 5_000,
      diagnosisResult: { summary: "already done" },
    }, now);
    const storage = createMockStorageWithIncidents([done]);
    const runner = createMockRunner();
    const waitUntilFn = vi.fn((p: Promise<unknown>) => { void p; });

    recoverOrphanedDiagnoses(storage, runner, waitUntilFn, now);
    await vi.waitFor(() => expect(storage.listIncidents).toHaveBeenCalled());

    expect(runner.run).not.toHaveBeenCalled();
  });

  it("clears stale lease (dispatchedAt > DEFAULT_DIAGNOSIS_LEASE_MS) then recovers", async () => {
    const now = Date.now();
    const staleLeaseOrphan = makeOrphanIncident({
      scheduledMsAgo: ORPHAN_SCHEDULED_THRESHOLD_MS + 5_000,
      dispatchedMsAgo: DEFAULT_DIAGNOSIS_LEASE_MS + 1_000, // stale lease
    }, now);
    const storage = createMockStorageWithIncidents([staleLeaseOrphan]);
    const runner = createMockRunner();
    const waitUntilFn = vi.fn((p: Promise<unknown>) => { void p; });

    recoverOrphanedDiagnoses(storage, runner, waitUntilFn, now);

    await vi.waitFor(() => {
      expect(storage.releaseDiagnosisDispatch).toHaveBeenCalledWith("inc_orphan");
      expect(runner.run).toHaveBeenCalledWith("inc_orphan");
    });
  });

  it("does NOT recover incident with a valid (non-expired) lease", async () => {
    const now = Date.now();
    const validLease = makeOrphanIncident({
      scheduledMsAgo: ORPHAN_SCHEDULED_THRESHOLD_MS + 5_000,
      dispatchedMsAgo: 60_000, // 1 min ago — within 15 min lease
    }, now);
    const storage = createMockStorageWithIncidents([validLease]);
    const runner = createMockRunner();
    const waitUntilFn = vi.fn((p: Promise<unknown>) => { void p; });

    recoverOrphanedDiagnoses(storage, runner, waitUntilFn, now);
    await vi.waitFor(() => expect(storage.listIncidents).toHaveBeenCalled());

    expect(storage.releaseDiagnosisDispatch).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("throttle: second call within ORPHAN_CHECK_INTERVAL_MS is a no-op", async () => {
    const now = Date.now();
    const orphan = makeOrphanIncident({ scheduledMsAgo: ORPHAN_SCHEDULED_THRESHOLD_MS + 1_000 }, now);
    const storage = createMockStorageWithIncidents([orphan]);
    const runner = createMockRunner();
    const waitUntilFn = vi.fn((p: Promise<unknown>) => { void p; });

    // First call: should proceed
    recoverOrphanedDiagnoses(storage, runner, waitUntilFn, now);
    // Second call: within throttle interval — should be skipped
    recoverOrphanedDiagnoses(storage, runner, waitUntilFn, now + ORPHAN_CHECK_INTERVAL_MS - 1);

    // waitUntil should have been called only once
    expect(waitUntilFn).toHaveBeenCalledTimes(1);
  });

  it("throttle: call after ORPHAN_CHECK_INTERVAL_MS elapses proceeds again", async () => {
    const now = Date.now();
    const orphan = makeOrphanIncident({ scheduledMsAgo: ORPHAN_SCHEDULED_THRESHOLD_MS + 1_000 }, now);
    const storage = createMockStorageWithIncidents([orphan]);
    const runner = createMockRunner();
    const waitUntilFn = vi.fn((p: Promise<unknown>) => { void p; });

    recoverOrphanedDiagnoses(storage, runner, waitUntilFn, now);
    // Reset inFlight so runIfNeeded won't be blocked by previous run
    _resetInFlightForTest();
    recoverOrphanedDiagnoses(storage, runner, waitUntilFn, now + ORPHAN_CHECK_INTERVAL_MS + 1);

    expect(waitUntilFn).toHaveBeenCalledTimes(2);
  });
});
