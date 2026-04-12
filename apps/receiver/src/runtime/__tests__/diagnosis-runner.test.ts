import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DiagnosisRunner } from "../diagnosis-runner.js";
import type { StorageDriver } from "../../storage/interface.js";
import type { Incident } from "../../storage/interface.js";
import type { TelemetryStoreDriver } from "../../telemetry/interface.js";

vi.mock("3am-diagnosis", () => ({
  diagnose: vi.fn(),
  generateConsoleNarrative: vi.fn(),
}));

vi.mock("../../domain/reasoning-structure-builder.js", () => ({
  buildReasoningStructure: vi.fn(),
}));

vi.mock("../materialization.js", () => ({
  ensureIncidentMaterialized: vi.fn().mockResolvedValue(false),
}));

import { diagnose, generateConsoleNarrative } from "3am-diagnosis";
import { buildReasoningStructure } from "../../domain/reasoning-structure-builder.js";
import { ensureIncidentMaterialized } from "../materialization.js";

function makeIncident(partial: Partial<Incident> = {}): Incident {
  return {
    incidentId: "inc_test",
    status: "open",
    openedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    packet: {
      incidentId: "inc_test",
      packetId: "pkt_test",
      schemaVersion: "incident-packet/v1alpha1",
      openedAt: new Date().toISOString(),
      identity: { environment: "test", primaryService: "web" },
      situation: { anomalySummary: "test error", windowStartMs: 0, windowEndMs: 1000 },
      evidence: { anomalousSignals: [], spanEvidence: [], metricEvidence: [], logEvidence: [] },
      retrieval: { packetGeneratedAt: new Date().toISOString(), packetVersion: 1 },
    } as never,
    telemetryScope: {
      windowStartMs: 0,
      windowEndMs: 1000,
      detectTimeMs: 0,
      environment: "test",
      memberServices: [],
      dependencyServices: [],
    },
    spanMembership: [],
    anomalousSignals: [],
    platformEvents: [],
    ...partial,
  };
}

function makeStorage(overrides: Partial<StorageDriver> = {}): StorageDriver {
  return {
    createIncident: vi.fn(),
    updatePacket: vi.fn(),
    updateIncidentStatus: vi.fn(),
    touchIncidentActivity: vi.fn(),
    appendDiagnosis: vi.fn().mockResolvedValue(undefined),
    appendConsoleNarrative: vi.fn().mockResolvedValue(undefined),
    listIncidents: vi.fn(),
    getIncident: vi.fn().mockResolvedValue(makeIncident()),
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
    // Materialization lease: return false by default (no-op in tests — materialization skips rebuild)
    claimMaterializationLease: vi.fn().mockResolvedValue(false),
    releaseMaterializationLease: vi.fn().mockResolvedValue(undefined),
    claimDiagnosisDispatch: vi.fn().mockResolvedValue(true),
    releaseDiagnosisDispatch: vi.fn().mockResolvedValue(undefined),
    markDiagnosisScheduled: vi.fn().mockResolvedValue(undefined),
    clearDiagnosisScheduled: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as StorageDriver;
}

function makeTelemetryStore(): TelemetryStoreDriver {
  return {
    ingestSpans: vi.fn(),
    ingestMetrics: vi.fn(),
    ingestLogs: vi.fn(),
    querySpans: vi.fn().mockResolvedValue([]),
    queryMetrics: vi.fn().mockResolvedValue([]),
    queryLogs: vi.fn().mockResolvedValue([]),
    upsertSnapshot: vi.fn(),
    getSnapshots: vi.fn().mockResolvedValue([]),
    deleteSnapshots: vi.fn(),
    deleteExpired: vi.fn(),
  } as unknown as TelemetryStoreDriver;
}

describe("DiagnosisRunner", () => {
  const originalApiKey = process.env["ANTHROPIC_API_KEY"];
  const originalMode = process.env["LLM_MODE"];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalApiKey !== undefined) {
      process.env["ANTHROPIC_API_KEY"] = originalApiKey;
    } else {
      delete process.env["ANTHROPIC_API_KEY"];
    }
    if (originalMode !== undefined) {
      process.env["LLM_MODE"] = originalMode;
    } else {
      delete process.env["LLM_MODE"];
    }
  });

  it("skips diagnosis when manual mode is enabled and returns false", async () => {
    process.env["LLM_MODE"] = "manual";
    const storage = makeStorage();
    const runner = new DiagnosisRunner(storage, makeTelemetryStore());
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await runner.run("inc_test");

    expect(result).toBe(false);
    expect(diagnose).not.toHaveBeenCalled();
    expect(storage.appendDiagnosis).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("manual mode"));
    warnSpy.mockRestore();
  });

  it("runs diagnosis and stores result on success, returns true", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    const mockResult = { summary: { what_happened: "test" } } as never;
    vi.mocked(diagnose).mockResolvedValueOnce(mockResult);
    const storage = makeStorage();
    const runner = new DiagnosisRunner(storage, makeTelemetryStore());

    const result = await runner.run("inc_test");

    expect(result).toBe(true);
    expect(storage.getIncident).toHaveBeenCalledWith("inc_test");
    expect(diagnose).toHaveBeenCalledWith(
      expect.objectContaining({ incidentId: "inc_test" }),
      expect.objectContaining({ locale: "en" }),
    );
    expect(storage.appendDiagnosis).toHaveBeenCalledWith("inc_test", mockResult);
  });

  it("logs error and returns false when diagnose() fails", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    vi.mocked(diagnose).mockRejectedValueOnce(new Error("LLM error"));
    const storage = makeStorage();
    const runner = new DiagnosisRunner(storage, makeTelemetryStore());
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runner.run("inc_test");

    expect(result).toBe(false);
    expect(storage.appendDiagnosis).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("inc_test: Error: LLM error"));
    errorSpy.mockRestore();
  });

  it("logs warn and returns false when incident is not found", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    const storage = makeStorage({ getIncident: vi.fn().mockResolvedValue(null) });
    const runner = new DiagnosisRunner(storage, makeTelemetryStore());
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await runner.run("inc_missing");

    expect(result).toBe(false);
    expect(diagnose).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("inc_missing"));
    warnSpy.mockRestore();
  });

  describe("stage 2 narrative generation", () => {
    const mockDiagnosisResult = { summary: { what_happened: "test" }, metadata: { created_at: "2026-01-01T00:00:00Z", packet_id: "pkt_test" }, confidence: { confidence_assessment: "high confidence", uncertainty: "" }, recommendation: { immediate_action: "", action_rationale_short: "", do_not: "" }, reasoning: { causal_chain: [] }, operator_guidance: { operator_checks: [] } } as never;
    const mockNarrative = { headline: "test narrative" } as never;
    const mockReasoningStructure = { incidentId: "inc_test" } as never;

    it("runs stage 2 after stage 1 when buildReasoningStructure succeeds", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key";
      vi.mocked(diagnose).mockResolvedValueOnce(mockDiagnosisResult);
      vi.mocked(buildReasoningStructure).mockResolvedValueOnce(mockReasoningStructure);
      vi.mocked(generateConsoleNarrative).mockResolvedValueOnce(mockNarrative);
      const storage = makeStorage();
      const runner = new DiagnosisRunner(storage, makeTelemetryStore());

      const result = await runner.run("inc_test");

      expect(result).toBe(true);
      expect(buildReasoningStructure).toHaveBeenCalled();
      expect(generateConsoleNarrative).toHaveBeenCalledWith(
        mockDiagnosisResult,
        mockReasoningStructure,
        expect.objectContaining({ locale: "en" }),
      );
      expect(storage.appendConsoleNarrative).toHaveBeenCalledWith("inc_test", mockNarrative);
    });

    it("retries once when generateConsoleNarrative fails", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key";
      vi.mocked(diagnose).mockResolvedValueOnce(mockDiagnosisResult);
      vi.mocked(buildReasoningStructure).mockResolvedValueOnce(mockReasoningStructure);
      vi.mocked(generateConsoleNarrative)
        .mockRejectedValueOnce(new Error("LLM timeout"))
        .mockResolvedValueOnce(mockNarrative);
      const storage = makeStorage();
      const runner = new DiagnosisRunner(storage, makeTelemetryStore());
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await runner.run("inc_test");

      expect(generateConsoleNarrative).toHaveBeenCalledTimes(2);
      expect(storage.appendConsoleNarrative).toHaveBeenCalledWith("inc_test", mockNarrative);
      warnSpy.mockRestore();
    });

    it("logs error when both attempts fail but stage 1 is preserved", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key";
      vi.mocked(diagnose).mockResolvedValueOnce(mockDiagnosisResult);
      vi.mocked(buildReasoningStructure).mockResolvedValueOnce(mockReasoningStructure);
      vi.mocked(generateConsoleNarrative)
        .mockRejectedValueOnce(new Error("fail 1"))
        .mockRejectedValueOnce(new Error("fail 2"));
      const storage = makeStorage();
      const runner = new DiagnosisRunner(storage, makeTelemetryStore());
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await runner.run("inc_test");

      expect(result).toBe(true); // stage 1 succeeded
      expect(storage.appendDiagnosis).toHaveBeenCalled();
      expect(storage.appendConsoleNarrative).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("retry also failed"), expect.any(Error));
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });

  describe("rerunNarrative", () => {
    const mockDiagnosisResult = { metadata: { created_at: "2026-01-01T00:00:00Z", packet_id: "pkt_test" } } as never;
    const mockNarrative = { headline: "regenerated" } as never;
    const mockReasoningStructure = { incidentId: "inc_test" } as never;

    it("re-runs stage 2 for diagnosed incident and returns true on success", async () => {
      const incident = makeIncident({ diagnosisResult: mockDiagnosisResult });
      const storage = makeStorage({ getIncident: vi.fn().mockResolvedValue(incident) });
      vi.mocked(buildReasoningStructure).mockResolvedValueOnce(mockReasoningStructure);
      vi.mocked(generateConsoleNarrative).mockResolvedValueOnce(mockNarrative);
      const runner = new DiagnosisRunner(storage, makeTelemetryStore());

      const result = await runner.rerunNarrative("inc_test");

      expect(result).toBe(true);
      expect(generateConsoleNarrative).toHaveBeenCalled();
      expect(storage.appendConsoleNarrative).toHaveBeenCalledWith("inc_test", mockNarrative);
    });

    it("returns false when incident has no stage 1 result", async () => {
      const incident = makeIncident(); // no diagnosisResult
      const storage = makeStorage({ getIncident: vi.fn().mockResolvedValue(incident) });
      const runner = new DiagnosisRunner(storage, makeTelemetryStore());
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await runner.rerunNarrative("inc_test");

      expect(result).toBe(false);
      expect(generateConsoleNarrative).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("returns false when incident not found", async () => {
      const storage = makeStorage({ getIncident: vi.fn().mockResolvedValue(null) });
      const runner = new DiagnosisRunner(storage, makeTelemetryStore());
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await runner.rerunNarrative("inc_missing");

      expect(result).toBe(false);
      warnSpy.mockRestore();
    });
  });

  describe("Fix 5.2: pre-diagnosis materialization + re-fetch", () => {
    it("calls ensureIncidentMaterialized before getIncident", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key";
      const mockResult = { summary: { what_happened: "test" } } as never;
      vi.mocked(diagnose).mockResolvedValueOnce(mockResult);
      const callOrder: string[] = [];
      const storage = makeStorage({
        getIncident: vi.fn().mockImplementation(() => {
          callOrder.push("getIncident");
          return Promise.resolve(makeIncident());
        }),
      });
      vi.mocked(ensureIncidentMaterialized).mockImplementationOnce(async () => {
        callOrder.push("ensureIncidentMaterialized");
        return false;
      });
      const runner = new DiagnosisRunner(storage, makeTelemetryStore());

      await runner.run("inc_test");

      expect(callOrder[0]).toBe("ensureIncidentMaterialized");
      expect(callOrder[1]).toBe("getIncident");
    });

    it("passes the re-fetched (post-materialization) incident to diagnose()", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key";
      const staleIncident = makeIncident(); // fetched before materialization (not used by runner)
      const freshIncident = makeIncident({
        packet: {
          ...makeIncident().packet,
          generation: 6,
        } as never,
      });
      const mockResult = { summary: { what_happened: "payment timeout" } } as never;
      vi.mocked(diagnose).mockResolvedValueOnce(mockResult);
      // getIncident is called once (post-materialization re-fetch) — returns freshIncident
      const storage = makeStorage({
        getIncident: vi.fn().mockResolvedValue(freshIncident),
      });
      vi.mocked(ensureIncidentMaterialized).mockResolvedValueOnce(true);
      const runner = new DiagnosisRunner(storage, makeTelemetryStore());

      await runner.run("inc_test");

      // diagnose() must have been called with the fresh packet (generation: 6)
      expect(diagnose).toHaveBeenCalledWith(
        expect.objectContaining({ generation: 6 }),
        expect.any(Object),
      );
      void staleIncident; // suppress unused warning
    });

    it("proceeds with diagnosis even when ensureIncidentMaterialized returns false (lease contention)", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key";
      const mockResult = { summary: { what_happened: "test" } } as never;
      vi.mocked(diagnose).mockResolvedValueOnce(mockResult);
      vi.mocked(ensureIncidentMaterialized).mockResolvedValueOnce(false); // no-op
      const storage = makeStorage();
      const runner = new DiagnosisRunner(storage, makeTelemetryStore());

      const result = await runner.run("inc_test");

      expect(result).toBe(true);
      expect(diagnose).toHaveBeenCalled();
    });
  });
});
