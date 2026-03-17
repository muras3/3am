/**
 * Integration tests for the diagnosis debouncer — verifies that thin event
 * dispatch is deferred when DIAGNOSIS_GENERATION_THRESHOLD / DIAGNOSIS_MAX_WAIT_MS
 * are set, and immediate when both are 0 (backward compat).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoryAdapter } from "../storage/adapters/memory.js";
import { createApp } from "../index.js";

// Mock dispatchThinEvent to capture calls without hitting GitHub API
vi.mock("../runtime/github-dispatch.js", () => ({
  dispatchThinEvent: vi.fn().mockResolvedValue(undefined),
}));
import { dispatchThinEvent } from "../runtime/github-dispatch.js";

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
    vi.mocked(dispatchThinEvent).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
    delete process.env["DIAGNOSIS_GENERATION_THRESHOLD"];
    delete process.env["DIAGNOSIS_MAX_WAIT_MS"];
  });

  it("does NOT dispatch immediately when debouncer is active", async () => {
    process.env["DIAGNOSIS_GENERATION_THRESHOLD"] = "5";
    process.env["DIAGNOSIS_MAX_WAIT_MS"] = "180000";
    const app = createApp(new MemoryAdapter());

    await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(errorSpanPayload("t1", "s1")),
    });

    expect(dispatchThinEvent).not.toHaveBeenCalled();
  });

  it("dispatches on max wait timeout", async () => {
    process.env["DIAGNOSIS_GENERATION_THRESHOLD"] = "999";
    process.env["DIAGNOSIS_MAX_WAIT_MS"] = "5000";
    const app = createApp(new MemoryAdapter());

    await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(errorSpanPayload("t1", "s1")),
    });

    expect(dispatchThinEvent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(dispatchThinEvent).toHaveBeenCalledTimes(1);
  });

  it("dispatches immediately when both thresholds are 0 (backward compat)", async () => {
    process.env["DIAGNOSIS_GENERATION_THRESHOLD"] = "0";
    process.env["DIAGNOSIS_MAX_WAIT_MS"] = "0";
    const app = createApp(new MemoryAdapter());

    await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(errorSpanPayload("t1", "s1")),
    });

    expect(dispatchThinEvent).toHaveBeenCalledTimes(1);
  });

  it("dispatches when generation threshold is reached via repeated batches", async () => {
    // Low threshold so we can reach it with a few batches
    process.env["DIAGNOSIS_GENERATION_THRESHOLD"] = "3";
    process.env["DIAGNOSIS_MAX_WAIT_MS"] = "180000";
    const storage = new MemoryAdapter();
    const app = createApp(storage);

    // First batch — creates incident (generation starts at 1, then rebuild → 2)
    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(errorSpanPayload("t1", "s1")),
    });
    const { incidentId } = await res.json() as { incidentId: string };
    expect(dispatchThinEvent).not.toHaveBeenCalled();

    // Second batch — attaches to same incident → rebuild → generation 3 → threshold reached
    await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(errorSpanPayload("t1", "s2")),
    });

    // Generation threshold should have fired the debouncer
    expect(dispatchThinEvent).toHaveBeenCalledTimes(1);

    // Verify thin event was saved to storage
    const events = await storage.listThinEvents();
    expect(events).toHaveLength(1);
    expect(events[0].incident_id).toBe(incidentId);
  });
});
