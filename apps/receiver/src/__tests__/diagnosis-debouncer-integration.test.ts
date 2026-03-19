/**
 * Integration tests for the diagnosis debouncer — verifies that inline diagnosis
 * is deferred when DIAGNOSIS_GENERATION_THRESHOLD / DIAGNOSIS_MAX_WAIT_MS are set,
 * and immediate when both are 0.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoryAdapter } from "../storage/adapters/memory.js";
import { createApp } from "../index.js";

// Mock DiagnosisRunner to capture calls without hitting LLM
const mockRun = vi.fn().mockResolvedValue(undefined);
vi.mock("../runtime/diagnosis-runner.js", () => ({
  DiagnosisRunner: vi.fn().mockImplementation(() => ({ run: mockRun })),
}));

const errorSpanPayload = (traceId: string, spanId: string) => ({
  resourceSpans: [{
    resource: {
      attributes: [
        { key: "service.name", value: { stringValue: "web" } },
        { key: "deployment.environment.name", value: { stringValue: "production" } },
      ],
    },
    scopeSpans: [{
      spans: [{
        traceId,
        spanId,
        name: "POST /checkout",
        startTimeUnixNano: "1741392000000000000",
        endTimeUnixNano: "1741392000500000000",
        status: { code: 2 },
        attributes: [
          { key: "http.route", value: { stringValue: "/checkout" } },
          { key: "http.response.status_code", value: { intValue: 500 } },
        ],
      }],
    }],
  }],
});

describe("Diagnosis debouncer integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env["RECEIVER_AUTH_TOKEN"];
    process.env["ALLOW_INSECURE_DEV_MODE"] = "true";
    mockRun.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
    delete process.env["DIAGNOSIS_GENERATION_THRESHOLD"];
    delete process.env["DIAGNOSIS_MAX_WAIT_MS"];
  });

  it("does NOT run diagnosis immediately when debouncer is active", async () => {
    process.env["DIAGNOSIS_GENERATION_THRESHOLD"] = "5";
    process.env["DIAGNOSIS_MAX_WAIT_MS"] = "180000";
    const app = createApp(new MemoryAdapter());

    await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(errorSpanPayload("t1", "s1")),
    });

    expect(mockRun).not.toHaveBeenCalled();
  });

  it("runs diagnosis on max wait timeout", async () => {
    process.env["DIAGNOSIS_GENERATION_THRESHOLD"] = "999";
    process.env["DIAGNOSIS_MAX_WAIT_MS"] = "5000";
    const app = createApp(new MemoryAdapter());

    await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(errorSpanPayload("t1", "s1")),
    });

    expect(mockRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it("runs diagnosis immediately when both thresholds are 0", async () => {
    process.env["DIAGNOSIS_GENERATION_THRESHOLD"] = "0";
    process.env["DIAGNOSIS_MAX_WAIT_MS"] = "0";
    const app = createApp(new MemoryAdapter());

    await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(errorSpanPayload("t1", "s1")),
    });

    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it("runs diagnosis when generation threshold is reached via repeated batches", async () => {
    process.env["DIAGNOSIS_GENERATION_THRESHOLD"] = "3";
    process.env["DIAGNOSIS_MAX_WAIT_MS"] = "180000";
    const storage = new MemoryAdapter();
    const app = createApp(storage);

    // First batch — creates incident
    await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(errorSpanPayload("t1", "s1")),
    });
    expect(mockRun).not.toHaveBeenCalled();

    // Second batch — attaches to same incident → rebuild → generation threshold reached
    await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(errorSpanPayload("t1", "s2")),
    });

    expect(mockRun).toHaveBeenCalledTimes(1);
  });
});
