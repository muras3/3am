import { describe, it, expect, vi, beforeEach } from "vitest";
import { ZodError } from "zod";

// Mock model-client BEFORE importing diagnose
vi.mock("../model-client.js", () => ({
  callModel: vi.fn(),
}));

import { diagnose } from "../diagnose.js";
import { callModel } from "../model-client.js";
import type { IncidentPacket } from "@3am/core";

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
        traceId: "t1",
        spanId: "s1",
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
    traceRefs: ["t1"],
    logRefs: [],
    metricRefs: [],
    platformLogRefs: [],
  },
};

const validModelResponse = JSON.stringify({
  summary: {
    what_happened: "Checkout failures.",
    root_cause_hypothesis: "Stripe rate limited.",
  },
  recommendation: {
    immediate_action: "Disable retries.",
    action_rationale_short: "Fastest fix.",
    do_not: "Don't restart.",
  },
  reasoning: {
    causal_chain: [{ type: "external", title: "Stripe 429", detail: "limit" }],
  },
  operator_guidance: {
    watch_items: [{ label: "Error rate", state: "dropping", status: "watch" }],
    operator_checks: ["Confirm in 60s"],
  },
  confidence: {
    confidence_assessment: "High.",
    uncertainty: "None.",
  },
});

describe("diagnose", () => {
  beforeEach(() => {
    vi.mocked(callModel).mockReset();
  });

  it("returns DiagnosisResult on valid model output", async () => {
    vi.mocked(callModel).mockResolvedValue(validModelResponse);
    const result = await diagnose(packet);
    expect(result.metadata.incident_id).toBe("inc_test");
    expect(result.metadata.packet_id).toBe("pkt_test");
    expect(result.metadata.model).toBe("claude-sonnet-4-6");
    expect(result.summary.what_happened).toBe("Checkout failures.");
  });

  it("uses custom model when specified", async () => {
    vi.mocked(callModel).mockResolvedValue(validModelResponse);
    const result = await diagnose(packet, { model: "claude-opus-4-6" });
    expect(result.metadata.model).toBe("claude-opus-4-6");
    expect(vi.mocked(callModel).mock.calls[0]![1].model).toBe("claude-opus-4-6");
  });

  it("throws ZodError when model returns invalid schema", async () => {
    vi.mocked(callModel).mockResolvedValue(JSON.stringify({ foo: "bar" }));
    await expect(diagnose(packet)).rejects.toThrow(ZodError);
  });

  it("throws when model returns unparseable output", async () => {
    vi.mocked(callModel).mockResolvedValue("I cannot help with that.");
    await expect(diagnose(packet)).rejects.toThrow();
  });
});
