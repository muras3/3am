import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { ReasoningStructureSchema } from "../reasoning-structure.js";

const minimalValid = {
  incidentId: "inc_001",
  evidenceCounts: { traces: 47, traceErrors: 12, metrics: 6, logs: 234, logErrors: 89 },
  blastRadius: [
    { targetId: "service:payment-service", label: "payment-service", status: "critical", impactValue: 0.68, displayValue: "68%" },
    { targetId: "service:order-service", label: "order-service", status: "degraded", impactValue: 0.23, displayValue: "23%" },
  ],
  proofRefs: [
    { cardId: "trigger", targetSurface: "traces", evidenceRefs: [{ kind: "span", id: "tid:a3f8:sid:c91d" }], status: "confirmed" },
    { cardId: "design_gap", targetSurface: "metrics", evidenceRefs: [{ kind: "metric", id: "stripe_429_rate::payment-service" }], status: "confirmed" },
    { cardId: "recovery", targetSurface: "logs", evidenceRefs: [], status: "pending" },
  ],
  absenceCandidates: [
    { id: "no-retry", patterns: ["retry", "backoff", "circuit_breaker"], searchWindow: { startMs: 1710940995000, endMs: 1710941490000 }, matchCount: 0 },
  ],
  timelineSummary: { startedAt: "2026-03-20T14:23:15Z", fullCascadeAt: "2026-03-20T14:25:30Z", diagnosedAt: "2026-03-20T14:27:45Z" },
  qaContext: { availableEvidenceKinds: ["traces", "metrics", "logs"] },
};

describe("ReasoningStructureSchema", () => {
  it("accepts a valid reasoning structure", () => {
    const result = ReasoningStructureSchema.parse(minimalValid);
    expect(result.incidentId).toBe("inc_001");
    expect(result.proofRefs).toHaveLength(3);
  });

  it("requires all three proof card IDs", () => {
    const valid = ReasoningStructureSchema.parse(minimalValid);
    const cardIds = valid.proofRefs.map((r) => r.cardId);
    expect(cardIds).toContain("trigger");
    expect(cardIds).toContain("design_gap");
    expect(cardIds).toContain("recovery");
  });

  it("rejects invalid cardId", () => {
    const bad = {
      ...minimalValid,
      proofRefs: [{ cardId: "unknown", targetSurface: "traces", evidenceRefs: [], status: "pending" }],
    };
    expect(() => ReasoningStructureSchema.parse(bad)).toThrow(ZodError);
  });

  it("rejects invalid evidence ref kind", () => {
    const bad = {
      ...minimalValid,
      proofRefs: [
        { cardId: "trigger", targetSurface: "traces", evidenceRefs: [{ kind: "proof_card", id: "trigger" }], status: "confirmed" },
      ],
    };
    expect(() => ReasoningStructureSchema.parse(bad)).toThrow(ZodError);
  });

  it("rejects unknown top-level fields (strict)", () => {
    expect(() => ReasoningStructureSchema.parse({ ...minimalValid, extra: true })).toThrow(ZodError);
  });

  it("accepts empty evidenceRefs for pending cards", () => {
    const result = ReasoningStructureSchema.parse(minimalValid);
    const recovery = result.proofRefs.find((r) => r.cardId === "recovery");
    expect(recovery?.evidenceRefs).toHaveLength(0);
    expect(recovery?.status).toBe("pending");
  });

  it("accepts null for optional timeline fields", () => {
    const withNull = {
      ...minimalValid,
      timelineSummary: { startedAt: "2026-03-20T14:23:15Z", fullCascadeAt: null, diagnosedAt: null },
    };
    const result = ReasoningStructureSchema.parse(withNull);
    expect(result.timelineSummary.fullCascadeAt).toBeNull();
  });

  it("requires matchCount >= 0", () => {
    const bad = {
      ...minimalValid,
      absenceCandidates: [{ id: "x", patterns: ["retry"], searchWindow: { startMs: 0, endMs: 1 }, matchCount: -1 }],
    };
    expect(() => ReasoningStructureSchema.parse(bad)).toThrow(ZodError);
  });

  it("requires impactValue in [0, 1]", () => {
    const bad = {
      ...minimalValid,
      blastRadius: [{ targetId: "s:a", label: "a", status: "critical", impactValue: 1.5, displayValue: "150%" }],
    };
    expect(() => ReasoningStructureSchema.parse(bad)).toThrow(ZodError);
  });
});
