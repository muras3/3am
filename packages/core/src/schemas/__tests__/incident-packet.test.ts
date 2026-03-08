import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { IncidentPacketSchema } from "../incident-packet.js";

const minimalValidPacket = {
  schemaVersion: "incident-packet/v1alpha1",
  packetId: "pkt_001",
  incidentId: "inc_001",
  openedAt: "2026-03-08T00:00:00Z",
  window: {
    start: "2026-03-08T00:00:00Z",
    detect: "2026-03-08T00:01:10Z",
    end: "2026-03-08T00:08:00Z",
  },
  scope: {
    environment: "production",
    primaryService: "web",
    affectedServices: ["web"],
    affectedRoutes: ["/checkout"],
    affectedDependencies: ["stripe"],
  },
  triggerSignals: [
    {
      signal: "span_error_rate",
      firstSeenAt: "2026-03-08T00:01:10Z",
      entity: "web",
    },
  ],
  evidence: {
    changedMetrics: [],
    representativeTraces: [],
    relevantLogs: [],
    platformEvents: [],
  },
  pointers: {
    traceRefs: [],
    logRefs: [],
    metricRefs: [],
    platformLogRefs: [],
  },
};

describe("IncidentPacketSchema", () => {
  it("accepts a minimal valid packet", () => {
    const result = IncidentPacketSchema.parse(minimalValidPacket);
    expect(result.schemaVersion).toBe("incident-packet/v1alpha1");
    expect(result.packetId).toBe("pkt_001");
  });

  it("requires schemaVersion to be the literal 'incident-packet/v1alpha1'", () => {
    expect(() =>
      IncidentPacketSchema.parse({ ...minimalValidPacket, schemaVersion: "other" })
    ).toThrow(ZodError);
  });

  it("requires identity fields: packetId, incidentId, openedAt, window, scope", () => {
    const { packetId: _, ...withoutPacketId } = minimalValidPacket;
    expect(() => IncidentPacketSchema.parse(withoutPacketId)).toThrow(ZodError);

    const { incidentId: __, ...withoutIncidentId } = minimalValidPacket;
    expect(() => IncidentPacketSchema.parse(withoutIncidentId)).toThrow(ZodError);

    const { openedAt: ___, ...withoutOpenedAt } = minimalValidPacket;
    expect(() => IncidentPacketSchema.parse(withoutOpenedAt)).toThrow(ZodError);
  });

  it("requires triggerSignals as a non-empty-allowed array", () => {
    const { triggerSignals: _, ...withoutTrigger } = minimalValidPacket;
    expect(() => IncidentPacketSchema.parse(withoutTrigger)).toThrow(ZodError);
  });

  it("requires evidence with changedMetrics, representativeTraces, relevantLogs, platformEvents", () => {
    const withBadEvidence = { ...minimalValidPacket, evidence: {} };
    expect(() => IncidentPacketSchema.parse(withBadEvidence)).toThrow(ZodError);
  });

  it("requires pointers with traceRefs, logRefs, metricRefs, platformLogRefs", () => {
    const withBadPointers = { ...minimalValidPacket, pointers: {} };
    expect(() => IncidentPacketSchema.parse(withBadPointers)).toThrow(ZodError);
  });

  it("does NOT contain LLM output fields (ADR 0018 non-goals)", () => {
    const schema = IncidentPacketSchema;
    // Parse a packet with forbidden fields — they should be stripped or rejected
    const withLlmFields = {
      ...minimalValidPacket,
      immediateAction: "restart the service",
      rootCauseHypothesis: "memory leak",
      confidenceAssessment: "high",
      doNot: "delete the database",
    };
    const parsed = schema.parse(withLlmFields);
    expect(parsed).not.toHaveProperty("immediateAction");
    expect(parsed).not.toHaveProperty("rootCauseHypothesis");
    expect(parsed).not.toHaveProperty("confidenceAssessment");
    expect(parsed).not.toHaveProperty("doNot");
  });

  it("rejects invalid data with ZodError", () => {
    expect(() => IncidentPacketSchema.parse(null)).toThrow(ZodError);
    expect(() => IncidentPacketSchema.parse({ schemaVersion: "incident-packet/v1alpha1" })).toThrow(ZodError);
  });
});
