import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { ConsoleNarrativeSchema } from "../console-narrative.js";

const minimalValid = {
  headline: "Stripe API rate limit cascade causing payment failures",
  whyThisAction: "Stripe is returning 429 because payment-service sends one API call per transaction with no batching. Batching + backoff will reduce call volume by ~80%.",
  confidenceSummary: {
    basis: "Stripe 429 correlates with traffic surge, r=0.97",
    risk: "Backoff rollout without rate limiter guard may cause retry storm",
  },
  proofCards: [
    { id: "trigger", label: "External Trigger", summary: "Stripe API 429 responses starting at 14:23:15." },
    { id: "design_gap", label: "Design Gap", summary: "No request batching in StripeClient. Error rate correlates 1:1 with traffic." },
    { id: "recovery", label: "Recovery Signal", summary: "Retry traces with backoff show successful calls at reduced rate." },
  ],
  qa: {
    question: "Why are checkout payments failing?",
    answer: "Stripe API rate limit exceeded. payment-service sends unbatched API calls (1 per tx). During 3x traffic surge, this exceeded the 100 req/sec quota.",
    answerEvidenceRefs: [
      { kind: "span", id: "tid:a3f8:sid:c91d" },
      { kind: "metric", id: "stripe_429_rate::payment-service" },
    ],
    evidenceBindings: [
      {
        claim: "Stripe API rate limit exceeded",
        evidenceRefs: [{ kind: "span", id: "tid:a3f8:sid:c91d" }],
      },
      {
        claim: "1 API call per transaction with no batching",
        evidenceRefs: [{ kind: "metric", id: "stripe_429_rate::payment-service" }],
      },
    ],
    followups: [
      { question: "Is there retry logic?", targetEvidenceKinds: ["logs"] },
      { question: "When exactly did this start?", targetEvidenceKinds: ["traces", "logs"] },
    ],
    noAnswerReason: null,
  },
  sideNotes: [
    { title: "Confidence", text: "High — Stripe 429 errors correlate strongly with traffic increase.", kind: "confidence" },
    { title: "Uncertainty", text: "Cannot confirm if Stripe rate limit is per-account or per-API-key.", kind: "uncertainty" },
  ],
  absenceEvidence: [
    {
      id: "no-retry",
      label: "No retry / backoff pattern found",
      expected: "retry or backoff log entries during 429 responses",
      observed: "0 matching entries",
      explanation: "This absence confirms the design gap — no resilience pattern exists.",
    },
  ],
  metadata: {
    model: "claude-haiku-4-5-20251001",
    prompt_version: "narrative-v1",
    created_at: "2026-03-20T14:28:00Z",
    stage1_packet_id: "pkt_001",
  },
};

describe("ConsoleNarrativeSchema", () => {
  it("accepts a valid console narrative", () => {
    const result = ConsoleNarrativeSchema.parse(minimalValid);
    expect(result.headline).toBe("Stripe API rate limit cascade causing payment failures");
    expect(result.proofCards).toHaveLength(3);
  });

  it("requires exactly 3 proof cards", () => {
    const twoCards = {
      ...minimalValid,
      proofCards: minimalValid.proofCards.slice(0, 2),
    };
    expect(() => ConsoleNarrativeSchema.parse(twoCards)).toThrow(ZodError);
  });

  it("requires proof card ids from fixed set", () => {
    const bad = {
      ...minimalValid,
      proofCards: [
        { id: "bad_id", label: "X", summary: "Y" },
        ...minimalValid.proofCards.slice(1),
      ],
    };
    expect(() => ConsoleNarrativeSchema.parse(bad)).toThrow(ZodError);
  });

  it("accepts headline over 120 characters", () => {
    const longHeadline = { ...minimalValid, headline: "x".repeat(180) };
    const result = ConsoleNarrativeSchema.parse(longHeadline);
    expect(result.headline).toHaveLength(180);
  });

  it("requires answerEvidenceRefs field", () => {
    const noAnswerRefs = { ...minimalValid, qa: { ...minimalValid.qa } };
    delete (noAnswerRefs.qa as Record<string, unknown>)["answerEvidenceRefs"];
    expect(() => ConsoleNarrativeSchema.parse(noAnswerRefs)).toThrow(ZodError);
  });

  it("requires ≥1 evidence ref per binding (concrete ref constraint)", () => {
    const emptyRefs = {
      ...minimalValid,
      qa: {
        ...minimalValid.qa,
        evidenceBindings: [{ claim: "some claim", evidenceRefs: [] }],
      },
    };
    expect(() => ConsoleNarrativeSchema.parse(emptyRefs)).toThrow(ZodError);
  });

  it("rejects 'proof_card' kind in evidence refs (concrete ref only)", () => {
    const withProofCard = {
      ...minimalValid,
      qa: {
        ...minimalValid.qa,
        evidenceBindings: [
          { claim: "x", evidenceRefs: [{ kind: "proof_card", id: "trigger" }] },
        ],
      },
    };
    expect(() => ConsoleNarrativeSchema.parse(withProofCard)).toThrow(ZodError);
  });

  it("requires ≥1 targetEvidenceKinds per follow-up", () => {
    const emptyKinds = {
      ...minimalValid,
      qa: {
        ...minimalValid.qa,
        followups: [{ question: "Q?", targetEvidenceKinds: [] }],
      },
    };
    expect(() => ConsoleNarrativeSchema.parse(emptyKinds)).toThrow(ZodError);
  });

  it("accepts noAnswerReason as string for unanswerable case", () => {
    const unanswerable = {
      ...minimalValid,
      qa: {
        ...minimalValid.qa,
        answer: "現在の evidence からは判断できません。insufficient data.",
        answerEvidenceRefs: [],
        evidenceBindings: [],
        noAnswerReason: "No relevant traces or logs found in the incident window.",
      },
    };
    const result = ConsoleNarrativeSchema.parse(unanswerable);
    expect(result.qa.noAnswerReason).toBeTruthy();
  });

  it("rejects unknown top-level fields (strict)", () => {
    expect(() => ConsoleNarrativeSchema.parse({ ...minimalValid, extra: true })).toThrow(ZodError);
  });

  it("rejects unknown fields in confidenceSummary (strict)", () => {
    const bad = {
      ...minimalValid,
      confidenceSummary: { ...minimalValid.confidenceSummary, label: "high" },
    };
    expect(() => ConsoleNarrativeSchema.parse(bad)).toThrow(ZodError);
  });

  it("proof card narrative does not contain status (diagnosis provides wording only)", () => {
    const shape = ConsoleNarrativeSchema.shape.proofCards.element.shape;
    expect("status" in shape).toBe(false);
  });

  it("qa does not contain confidence (removed in v4)", () => {
    const shape = ConsoleNarrativeSchema.shape.qa.shape;
    expect("confidence" in shape).toBe(false);
    expect("answerConfidence" in shape).toBe(false);
  });
});
