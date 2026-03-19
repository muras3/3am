import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { scheduleDelayedDiagnosis, checkGenerationThreshold } from "../diagnosis-debouncer.js";
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
  beforeEach(() => { vi.useFakeTimers(); });
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
