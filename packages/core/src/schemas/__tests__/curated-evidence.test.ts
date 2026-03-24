import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { EvidenceQueryResponseSchema, EvidenceResponseSchema } from "../curated-evidence.js";

const minimalValid = {
  proofCards: [
    {
      id: "trigger",
      label: "Trigger Evidence",
      status: "confirmed",
      summary: "1 deterministic traces reference captures the trigger path.",
      targetSurface: "traces",
      evidenceRefs: [{ kind: "span", id: "trace-1:span-1" }],
    },
    {
      id: "design_gap",
      label: "Design Gap",
      status: "inferred",
      summary: "Receiver reserved the design-gap card; diagnosis wording is pending and direct evidence is still sparse.",
      targetSurface: "metrics",
      evidenceRefs: [],
    },
    {
      id: "recovery",
      label: "Recovery Path",
      status: "pending",
      summary: "Recovery evidence is not available yet, but the recovery card remains visible by contract.",
      targetSurface: "traces",
      evidenceRefs: [],
    },
  ],
  qa: {
    question: "What explains the current incident on web /checkout?",
    answer: "Diagnosis wording is not ready yet. Use the deterministic traces, metrics, and logs below to inspect the current evidence.",
    evidenceRefs: [],
    evidenceSummary: { traces: 1, metrics: 0, logs: 0 },
    followups: [
      { question: "Which span is acting as the smoking gun?", targetEvidenceKinds: ["traces"] },
    ],
    noAnswerReason: "Diagnosis narrative is pending; deterministic evidence surfaces are available now.",
  },
  surfaces: {
    traces: {
      observed: [
        {
          traceId: "trace-1",
          route: "POST /checkout",
          status: 500,
          durationMs: 1200,
          expectedDurationMs: 300,
          annotation: "Observed 1200ms on POST /checkout versus expected 300ms (4.0x slower).",
          spans: [
            {
              spanId: "span-1",
              name: "POST /checkout",
              durationMs: 1200,
              status: "error",
              attributes: { "http.route": "/checkout" },
              correlatedLogs: [
                {
                  timestamp: "2024-01-01T00:00:01Z",
                  severity: "error",
                  body: "Stripe 429",
                },
              ],
            },
          ],
        },
      ],
      expected: [],
      smokingGunSpanId: "span-1",
    },
    metrics: { hypotheses: [] },
    logs: { claims: [] },
  },
  sideNotes: [],
  state: {
    diagnosis: "pending",
    baseline: "ready",
    evidenceDensity: "sparse",
  },
};

describe("EvidenceResponseSchema", () => {
  it("accepts the fixed-shape evidence response", () => {
    const result = EvidenceResponseSchema.parse(minimalValid);
    expect(result.proofCards).toHaveLength(3);
    expect(result.qa.question).toContain("web /checkout");
    expect(result.surfaces.traces.observed[0]?.spans[0]?.correlatedLogs?.[0]?.body).toBe("Stripe 429");
  });

  it("rejects qa: null", () => {
    expect(() =>
      EvidenceResponseSchema.parse({ ...minimalValid, qa: null }),
    ).toThrow(ZodError);
  });

  it("rejects proofCards arrays that do not contain all three slots", () => {
    expect(() =>
      EvidenceResponseSchema.parse({
        ...minimalValid,
        proofCards: minimalValid.proofCards.slice(0, 2),
      }),
    ).toThrow(ZodError);
  });
});

describe("EvidenceQueryResponseSchema", () => {
  it("accepts sentence-level grounded segments", () => {
    const parsed = EvidenceQueryResponseSchema.parse({
      question: "Why are payments failing?",
      status: "answered",
      segments: [
        {
          id: "seg-1",
          kind: "fact",
          text: "Checkout spans are failing with 504 responses.",
          evidenceRefs: [{ kind: "span", id: "trace-1:span-1" }],
        },
        {
          id: "seg-2",
          kind: "unknown",
          text: "The current evidence does not prove whether the upstream quota changed.",
          evidenceRefs: [{ kind: "absence", id: "missing-retry" }],
        },
      ],
      evidenceSummary: { traces: 1, metrics: 0, logs: 1 },
      followups: [
        { question: "Do the metrics show the same spike?", targetEvidenceKinds: ["metrics"] },
      ],
    });

    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[1]?.kind).toBe("unknown");
  });
});
