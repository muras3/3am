import { describe, it, expect } from "vitest";
import { buildPrompt } from "../prompt.js";
import type { IncidentPacket } from "@3amoncall/core";

const packet: IncidentPacket = {
  schemaVersion: "incident-packet/v1alpha1",
  packetId: "pkt_test",
  incidentId: "inc_test",
  openedAt: "2026-03-09T00:00:00Z",
  window: {
    start: "2026-03-09T00:00:00Z",
    detect: "2026-03-09T00:01:00Z",
    end: "2026-03-09T00:05:00Z",
  },
  scope: {
    environment: "production",
    primaryService: "checkout-api",
    affectedServices: ["checkout-api"],
    affectedRoutes: ["/checkout"],
    affectedDependencies: ["stripe"],
  },
  triggerSignals: [
    { signal: "http_500", firstSeenAt: "2026-03-09T00:01:00Z", entity: "checkout-api" },
  ],
  evidence: {
    changedMetrics: [],
    representativeTraces: [
      {
        traceId: "trace1",
        spanId: "span1",
        serviceName: "checkout-api",
        durationMs: 500,
        httpStatusCode: 500,
        spanStatusCode: 2,
      },
    ],
    relevantLogs: [],
    platformEvents: [],
  },
  pointers: {
    traceRefs: ["trace1"],
    logRefs: [],
    metricRefs: [],
    platformLogRefs: [],
  },
};

describe("buildPrompt", () => {
  it("includes primaryService in the prompt", () => {
    const prompt = buildPrompt(packet);
    expect(prompt).toContain("checkout-api");
  });

  it("includes affectedDependencies in the prompt", () => {
    const prompt = buildPrompt(packet);
    expect(prompt).toContain("stripe");
  });

  it("includes trigger signal in the prompt", () => {
    const prompt = buildPrompt(packet);
    expect(prompt).toContain("http_500");
  });

  it("includes trace information in the prompt", () => {
    const prompt = buildPrompt(packet);
    expect(prompt).toContain("trace1");
  });

  it("instructs output as JSON only", () => {
    const prompt = buildPrompt(packet);
    expect(prompt.toLowerCase()).toContain("json");
  });

  it("includes all 7 investigation steps", () => {
    const prompt = buildPrompt(packet);
    expect(prompt).toContain("Step 1");
    expect(prompt).toContain("Step 7");
  });
});
