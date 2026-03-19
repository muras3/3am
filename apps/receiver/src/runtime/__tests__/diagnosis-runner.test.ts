import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DiagnosisRunner } from "../diagnosis-runner.js";
import type { StorageDriver } from "../../storage/interface.js";
import type { Incident } from "../../storage/interface.js";

vi.mock("@3amoncall/diagnosis", () => ({
  diagnose: vi.fn(),
}));

import { diagnose } from "@3amoncall/diagnosis";

function makeIncident(partial: Partial<Incident> = {}): Incident {
  return {
    incidentId: "inc_test",
    status: "open",
    openedAt: new Date().toISOString(),
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
    appendDiagnosis: vi.fn().mockResolvedValue(undefined),
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
    ...overrides,
  } as StorageDriver;
}

describe("DiagnosisRunner", () => {
  const originalApiKey = process.env["ANTHROPIC_API_KEY"];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalApiKey !== undefined) {
      process.env["ANTHROPIC_API_KEY"] = originalApiKey;
    } else {
      delete process.env["ANTHROPIC_API_KEY"];
    }
  });

  it("skips diagnosis when ANTHROPIC_API_KEY is not set", async () => {
    delete process.env["ANTHROPIC_API_KEY"];
    const storage = makeStorage();
    const runner = new DiagnosisRunner(storage);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runner.run("inc_test");

    expect(diagnose).not.toHaveBeenCalled();
    expect(storage.appendDiagnosis).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ANTHROPIC_API_KEY"));
    warnSpy.mockRestore();
  });

  it("runs diagnosis and stores result on success", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    const mockResult = { summary: { what_happened: "test" } } as never;
    vi.mocked(diagnose).mockResolvedValueOnce(mockResult);
    const storage = makeStorage();
    const runner = new DiagnosisRunner(storage);

    await runner.run("inc_test");

    expect(storage.getIncident).toHaveBeenCalledWith("inc_test");
    expect(diagnose).toHaveBeenCalledWith(expect.objectContaining({ incidentId: "inc_test" }));
    expect(storage.appendDiagnosis).toHaveBeenCalledWith("inc_test", mockResult);
  });

  it("logs error but does not throw when diagnose() fails", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    vi.mocked(diagnose).mockRejectedValueOnce(new Error("LLM error"));
    const storage = makeStorage();
    const runner = new DiagnosisRunner(storage);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runner.run("inc_test")).resolves.toBeUndefined();

    expect(storage.appendDiagnosis).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("inc_test"), expect.any(Error));
    errorSpy.mockRestore();
  });

  it("logs warn when incident is not found", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    const storage = makeStorage({ getIncident: vi.fn().mockResolvedValue(null) });
    const runner = new DiagnosisRunner(storage);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runner.run("inc_missing");

    expect(diagnose).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("inc_missing"));
    warnSpy.mockRestore();
  });
});
