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

  it("rejects LLM output fields at parse time (ADR 0018 non-goals — camelCase, strict mode)", () => {
    const withLlmFields = {
      ...minimalValidPacket,
      immediateAction: "restart the service",
      rootCauseHypothesis: "memory leak",
      confidenceAssessment: "high",
      doNot: "delete the database",
    };
    expect(() => IncidentPacketSchema.parse(withLlmFields)).toThrow(ZodError);
  });

  it("does NOT contain LLM output fields (ADR 0018 non-goals — snake_case)", () => {
    const forbidden = [
      "immediate_action",
      "do_not",
      "root_cause_hypothesis",
      "confidence_assessment",
      "why_this_action",
    ];
    for (const field of forbidden) {
      expect(field in IncidentPacketSchema.shape).toBe(false);
    }
  });

  it("rejects invalid data with ZodError", () => {
    expect(() => IncidentPacketSchema.parse(null)).toThrow(ZodError);
    expect(() => IncidentPacketSchema.parse({ schemaVersion: "incident-packet/v1alpha1" })).toThrow(ZodError);
  });

  // F-204: PointersSchema refs must be z.string()
  it("rejects non-string values in traceRefs (F-204)", () => {
    const withNumericRef = {
      ...minimalValidPacket,
      pointers: { ...minimalValidPacket.pointers, traceRefs: [12345] },
    };
    expect(() => IncidentPacketSchema.parse(withNumericRef)).toThrow(ZodError);
  });

  // F-204: RepresentativeTraceSchema shape validation
  it("rejects representativeTraces with wrong shape (F-204)", () => {
    const withBadTrace = {
      ...minimalValidPacket,
      evidence: {
        ...minimalValidPacket.evidence,
        representativeTraces: [{ traceId: "abc", spanId: "def" }], // missing required fields
      },
    };
    expect(() => IncidentPacketSchema.parse(withBadTrace)).toThrow(ZodError);
  });

  it("accepts representativeTraces with valid RepresentativeTraceSchema shape (F-204)", () => {
    const withValidTrace = {
      ...minimalValidPacket,
      evidence: {
        ...minimalValidPacket.evidence,
        representativeTraces: [
          {
            traceId: "trace123",
            spanId: "span456",
            serviceName: "web",
            durationMs: 350,
            spanStatusCode: 2,
          },
        ],
      },
    };
    const result = IncidentPacketSchema.parse(withValidTrace);
    expect(result.evidence.representativeTraces).toHaveLength(1);
  });
});
