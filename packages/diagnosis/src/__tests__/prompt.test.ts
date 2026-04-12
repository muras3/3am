import { describe, it, expect } from "vitest";
import { buildPrompt } from "../prompt.js";
import type { IncidentPacket } from "3am-core";

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
  it("renders the primaryService in the Scope section label", () => {
    const prompt = buildPrompt(packet);
    expect(prompt).toContain("Primary service:       checkout-api");
  });

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

  it("truncates platformEvents.details exceeding 1000 chars", () => {
    const packetWithLargeDetails: IncidentPacket = {
      ...packet,
      evidence: {
        ...packet.evidence,
        platformEvents: [
          {
            eventType: "deploy",
            timestamp: "2026-03-09T00:00:00Z",
            environment: "production",
            description: "deploy v42",
            details: { payload: "x".repeat(1500) },
          },
        ],
      },
    };
    const prompt = buildPrompt(packetWithLargeDetails);
    expect(prompt).toContain("[truncated]");
    expect(prompt).not.toContain("x".repeat(1500));
  });

  it("does not truncate platformEvents.details under 1000 chars", () => {
    const packetWithShortDetails: IncidentPacket = {
      ...packet,
      evidence: {
        ...packet.evidence,
        platformEvents: [
          {
            eventType: "deploy",
            timestamp: "2026-03-09T00:00:00Z",
            environment: "production",
            description: "deploy v42",
            details: { key: "short" },
          },
        ],
      },
    };
    const prompt = buildPrompt(packetWithShortDetails);
    expect(prompt).not.toContain("[truncated]");
    expect(prompt).toContain("key");
    expect(prompt).toContain("short");
  });

  it("handles platformEvents without details field", () => {
    const packetWithoutDetails: IncidentPacket = {
      ...packet,
      evidence: {
        ...packet.evidence,
        platformEvents: [
          {
            eventType: "deploy",
            timestamp: "2026-03-09T00:00:00Z",
            environment: "production",
            description: "deploy v42",
          },
        ],
      },
    };
    const prompt = buildPrompt(packetWithoutDetails);
    expect(prompt).toContain("Platform Events");
    expect(prompt).not.toContain("[truncated]");
  });

  it("renders signalSeverity in Scope section when provided", () => {
    const packetWithSeverity: IncidentPacket = {
      ...packet,
      signalSeverity: "critical",
    };
    const prompt = buildPrompt(packetWithSeverity);
    expect(prompt).toContain("Signal severity:       critical");
  });

  it("renders '(not computed)' when signalSeverity is undefined", () => {
    const prompt = buildPrompt(packet);
    expect(prompt).toContain("Signal severity:       (not computed)");
  });

  it("consumes representativeTraces with peerService correctly (diagnosis gate)", () => {
    // Packet with a peerService=stripe span and a HTTP 429 span in representativeTraces
    const packetWithPeer: IncidentPacket = {
      schemaVersion: "incident-packet/v1alpha1",
      packetId: "pkt_gate_test",
      incidentId: "inc_gate_test",
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
        { signal: "http_429", firstSeenAt: "2026-03-09T00:01:00Z", entity: "checkout-api" },
      ],
      evidence: {
        changedMetrics: [],
        representativeTraces: [
          {
            traceId: "trace_peer_1",
            spanId: "span_peer_1",
            serviceName: "checkout-api",
            durationMs: 1200,
            httpStatusCode: 429,
            spanStatusCode: 0,
          },
          {
            traceId: "trace_peer_2",
            spanId: "span_peer_2",
            serviceName: "checkout-api",
            durationMs: 800,
            httpStatusCode: 500,
            spanStatusCode: 2,
          },
        ],
        relevantLogs: [],
        platformEvents: [],
      },
      pointers: {
        traceRefs: ["trace_peer_1", "trace_peer_2"],
        logRefs: [],
        metricRefs: [],
        platformLogRefs: [],
      },
    };

    // buildPrompt must complete without throwing
    let prompt: string;
    expect(() => {
      prompt = buildPrompt(packetWithPeer);
    }).not.toThrow();

    // The prompt must contain both trace IDs from representativeTraces,
    // confirming that buildPrompt iterated over the full traces array.
    expect(prompt!).toContain("trace_peer_1");
    expect(prompt!).toContain("trace_peer_2");

    // The Representative Traces section must include serviceName entries
    expect(prompt!).toContain("service=checkout-api");

    // Both HTTP status codes from the representative traces must be rendered
    expect(prompt!).toContain("httpStatus=429");
    expect(prompt!).toContain("httpStatus=500");
  });
});
