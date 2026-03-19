import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { scheduleDelayedDiagnosis, checkGenerationThreshold, _resetInFlightForTest } from "../diagnosis-debouncer.js";
import type { StorageDriver } from "../../storage/interface.js";
import type { DiagnosisRunner } from "../diagnosis-runner.js";

function createMockStorage(incident?: { diagnosisResult?: unknown }): StorageDriver {
  return {
    getIncident: vi.fn().mockResolvedValue(
      incident !== undefined
        ? { incidentId: "inc_1", diagnosisResult: incident.diagnosisResult, packet: { generation: 1 } }
        : null,
    ),
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
  return { run: vi.fn().mockResolvedValue(undefined) } as unknown as DiagnosisRunner & { run: ReturnType<typeof vi.fn> };
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
    const runPromise = new Promise<void>((r) => { resolveRun = r; });
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
    runner.run.mockResolvedValue(undefined);
    checkGenerationThreshold("inc_1", 50, storage, runner, { generationThreshold: 50 });
    await vi.advanceTimersByTimeAsync(0);

    expect(runner.run).toHaveBeenCalledTimes(2);
  });

  it("allows concurrent runs for different incidents", async () => {
    let resolveRun1!: () => void;
    const runPromise1 = new Promise<void>((r) => { resolveRun1 = r; });
    const runner = createMockRunner();
    runner.run.mockReturnValueOnce(runPromise1).mockResolvedValue(undefined);

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
