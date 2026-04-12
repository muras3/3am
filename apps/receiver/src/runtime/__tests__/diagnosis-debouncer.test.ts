import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { scheduleDelayedDiagnosis, checkGenerationThreshold, runIfNeeded, _resetInFlightForTest, shouldAllowRediagnosis } from "../diagnosis-debouncer.js";
import type { StorageDriver, Incident } from "../../storage/interface.js";
import type { DiagnosisRunner } from "../diagnosis-runner.js";

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

/** Build a partial Incident fixture with a diagnosisResult carrying packet_generation */
function makeIncidentWithDiagnosis(
  packetGeneration: number,
  diagnosedAtGeneration: number,
): Partial<Incident> {
  return {
    incidentId: "inc_1",
    packet: { generation: packetGeneration } as never,
    diagnosisResult: {
      metadata: { packet_generation: diagnosedAtGeneration },
    } as never,
  };
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

// ---------------------------------------------------------------------------
// Fix 5.3: shouldAllowRediagnosis unified predicate
// ---------------------------------------------------------------------------

describe("shouldAllowRediagnosis", () => {
  it("returns false for null incident", () => {
    expect(shouldAllowRediagnosis(null, 5)).toBe(false);
  });

  it("returns false for undefined incident", () => {
    expect(shouldAllowRediagnosis(undefined, 5)).toBe(false);
  });

  it("returns true when no diagnosisResult exists (initial diagnosis)", () => {
    const incident = { incidentId: "inc_1", packet: { generation: 1 }, diagnosisResult: undefined } as unknown as Incident;
    expect(shouldAllowRediagnosis(incident, 1)).toBe(true);
  });

  it("returns false when diagnosisResult has no metadata.packet_generation (legacy record)", () => {
    const incident = {
      incidentId: "inc_1",
      packet: { generation: 6 },
      diagnosisResult: { metadata: {} }, // no packet_generation
    } as unknown as Incident;
    expect(shouldAllowRediagnosis(incident, 6)).toBe(false);
  });

  it("returns false when diagnosisResult has no metadata at all (defensive guard)", () => {
    const incident = {
      incidentId: "inc_1",
      packet: { generation: 6 },
      diagnosisResult: { summary: "done" }, // no metadata
    } as unknown as Incident;
    expect(shouldAllowRediagnosis(incident, 6)).toBe(false);
  });

  it("returns false when currentGeneration === storedGeneration (already up-to-date)", () => {
    const incident = makeIncidentWithDiagnosis(6, 6) as Incident;
    expect(shouldAllowRediagnosis(incident, 6)).toBe(false);
  });

  it("returns false when currentGeneration < storedGeneration (should not happen, but safe)", () => {
    const incident = makeIncidentWithDiagnosis(5, 6) as Incident;
    expect(shouldAllowRediagnosis(incident, 5)).toBe(false);
  });

  it("returns true when currentGeneration > storedGeneration (stale packet — allow re-diagnosis)", () => {
    const incident = makeIncidentWithDiagnosis(6, 1) as Incident;
    expect(shouldAllowRediagnosis(incident, 6)).toBe(true);
  });

  it("returns false after re-diagnosis (new result carries updated generation)", () => {
    // After re-diagnosis, stored generation matches current → no further re-diagnoses
    const incident = makeIncidentWithDiagnosis(6, 6) as Incident;
    expect(shouldAllowRediagnosis(incident, 6)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fix 5.3: Three freeze checkpoints use the unified predicate
// ---------------------------------------------------------------------------

describe("scheduleDelayedDiagnosis freeze gate (Fix 5.3)", () => {
  beforeEach(() => { vi.useFakeTimers(); _resetInFlightForTest(); });
  afterEach(() => { vi.useRealTimers(); });

  it("skips runner.run when diagnosisResult has current generation (non-stale)", async () => {
    // diagnosisResult.metadata.packet_generation === current packet.generation → freeze
    const incident = {
      incidentId: "inc_1",
      packet: { generation: 6 },
      diagnosisResult: { metadata: { packet_generation: 6 } },
    };
    const storage = createMockStorage({ diagnosisResult: undefined });
    (storage.getIncident as ReturnType<typeof vi.fn>).mockResolvedValue(incident);
    const runner = createMockRunner();
    const waitUntilFn = vi.fn((p: Promise<unknown>) => { void p; });

    scheduleDelayedDiagnosis("inc_1", storage, runner, { maxWaitMs: 5_000 }, waitUntilFn);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(runner.run).not.toHaveBeenCalled();
  });

  it("calls runner.run when diagnosisResult has stale generation (packet advanced)", async () => {
    // diagnosisResult.metadata.packet_generation=1 but current packet.generation=6 → allow re-diagnosis
    const incident = {
      incidentId: "inc_1",
      packet: { generation: 6 },
      diagnosisResult: { metadata: { packet_generation: 1 } },
    };
    const storage = createMockStorage({ diagnosisResult: undefined });
    (storage.getIncident as ReturnType<typeof vi.fn>).mockResolvedValue(incident);
    const runner = createMockRunner();
    const waitUntilFn = vi.fn((p: Promise<unknown>) => { void p; });

    scheduleDelayedDiagnosis("inc_1", storage, runner, { maxWaitMs: 5_000 }, waitUntilFn);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(runner.run).toHaveBeenCalledWith("inc_1");
  });
});

describe("checkGenerationThreshold freeze gate (Fix 5.3)", () => {
  beforeEach(() => { _resetInFlightForTest(); });

  it("skips enqueue when diagnosisResult has current generation", async () => {
    const incident = {
      incidentId: "inc_1",
      packet: { generation: 6 },
      diagnosisResult: { metadata: { packet_generation: 6 } },
    };
    const storage = createMockStorage({ diagnosisResult: undefined });
    (storage.getIncident as ReturnType<typeof vi.fn>).mockResolvedValue(incident);
    const enqueueDiagnosis = vi.fn().mockResolvedValue(undefined);

    checkGenerationThreshold("inc_1", 6, storage, undefined, { generationThreshold: 5 }, enqueueDiagnosis);
    await new Promise((r) => setTimeout(r, 0));

    expect(enqueueDiagnosis).not.toHaveBeenCalled();
  });

  it("enqueues when diagnosisResult has stale generation", async () => {
    const incident = {
      incidentId: "inc_1",
      packet: { generation: 6 },
      diagnosisResult: { metadata: { packet_generation: 1 } },
    };
    const storage = createMockStorage({ diagnosisResult: undefined });
    (storage.getIncident as ReturnType<typeof vi.fn>).mockResolvedValue(incident);
    const enqueueDiagnosis = vi.fn().mockResolvedValue(undefined);

    checkGenerationThreshold("inc_1", 6, storage, undefined, { generationThreshold: 5 }, enqueueDiagnosis);
    await new Promise((r) => setTimeout(r, 0));

    expect(storage.markDiagnosisScheduled).toHaveBeenCalledWith("inc_1");
    expect(enqueueDiagnosis).toHaveBeenCalledWith("inc_1");
  });
});

describe("runIfNeeded freeze gate (Fix 5.3)", () => {
  beforeEach(() => { _resetInFlightForTest(); });

  it("skips when diagnosisResult has current generation (non-stale)", async () => {
    const incident = {
      incidentId: "inc_1",
      packet: { generation: 6 },
      diagnosisResult: { metadata: { packet_generation: 6 } },
    };
    const storage = createMockStorage({ diagnosisResult: undefined });
    (storage.getIncident as ReturnType<typeof vi.fn>).mockResolvedValue(incident);
    const runner = createMockRunner();

    const result = await runIfNeeded("inc_1", storage, runner);

    expect(result).toBe("skipped");
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("proceeds when diagnosisResult has stale generation", async () => {
    const incident = {
      incidentId: "inc_1",
      packet: { generation: 6 },
      diagnosisResult: { metadata: { packet_generation: 1 } },
    };
    const storage = createMockStorage({ diagnosisResult: undefined });
    (storage.getIncident as ReturnType<typeof vi.fn>).mockResolvedValue(incident);
    const runner = createMockRunner();

    const result = await runIfNeeded("inc_1", storage, runner);

    expect(result).toBe("succeeded");
    expect(runner.run).toHaveBeenCalledWith("inc_1");
  });
});
