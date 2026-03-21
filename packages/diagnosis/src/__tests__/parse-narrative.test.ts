import { describe, expect, it } from "vitest";
import { parseNarrative } from "../parse-narrative.js";
import { rateLimit as rsFixture } from "../__fixtures__/reasoning-structures.js";

const meta = { model: "test-model", promptVersion: "narrative-v1", stage1PacketId: "pkt_001" };

const validOutput = {
  headline: "Payment API rate limit cascade causing checkout failures",
  whyThisAction: "The payment API is returning 429 because the checkout-orchestrator sends one call per transaction with no batching. During the traffic surge, this exceeded the rate limit. Adding backoff with jitter and batching will reduce call volume by ~80%.",
  confidenceSummary: {
    basis: "429 errors correlate directly with traffic volume (r=0.97)",
    risk: "Backoff rollout without rate limiter guard may cause retry storm",
  },
  proofCards: [
    { id: "trigger", label: "External Trigger", summary: "Payment API 429 responses starting at 14:23:15." },
    { id: "design_gap", label: "Design Gap", summary: "Worker pool saturation from fixed-interval retries." },
    { id: "recovery", label: "Recovery Signal", summary: "Evidence not yet available for recovery assessment." },
  ],
  qa: {
    question: "Why are checkout payments failing?",
    answer: "The payment API rate limit was exceeded due to unbatched retry logic.",
    evidenceBindings: [
      { claim: "Payment API rate limit exceeded", evidenceRefs: [{ kind: "span", id: "tid:a3f8:sid:pay429" }] },
      { claim: "Worker pool saturated from retries", evidenceRefs: [{ kind: "metric", id: "worker_pool_in_use::checkout-orchestrator" }] },
    ],
    followups: [
      { question: "Is there backoff logic?", targetEvidenceKinds: ["logs"] },
      { question: "When did the rate limit hit?", targetEvidenceKinds: ["traces", "logs"] },
    ],
    noAnswerReason: null,
  },
  sideNotes: [
    { title: "Confidence", text: "High — 429 errors correlate with traffic volume.", kind: "confidence" },
    { title: "Uncertainty", text: "Payment provider quota bucket behavior is not visible.", kind: "uncertainty" },
  ],
  absenceEvidence: [
    { id: "no-backoff", label: "No backoff pattern found", expected: "backoff or circuit breaker entries during 429 responses", observed: "0 matching entries", explanation: "Confirms the design gap — no resilience pattern exists." },
  ],
};

describe("parseNarrative", () => {
  it("parses a valid JSON string", () => {
    const result = parseNarrative(JSON.stringify(validOutput), meta, rsFixture);
    expect(result.headline).toBe(validOutput.headline);
    expect(result.metadata.model).toBe("test-model");
    expect(result.metadata.stage1_packet_id).toBe("pkt_001");
  });

  it("parses JSON from code fence", () => {
    const wrapped = "```json\n" + JSON.stringify(validOutput) + "\n```";
    const result = parseNarrative(wrapped, meta, rsFixture);
    expect(result.headline).toBe(validOutput.headline);
  });

  it("rejects unparseable input", () => {
    expect(() => parseNarrative("not json at all", meta, rsFixture)).toThrow(
      "Failed to parse narrative output as JSON",
    );
  });

  it("rejects headline over 120 chars", () => {
    const bad = { ...validOutput, headline: "x".repeat(121) };
    expect(() => parseNarrative(JSON.stringify(bad), meta, rsFixture)).toThrow();
  });

  it("rejects invented evidence ref IDs", () => {
    const bad = {
      ...validOutput,
      qa: {
        ...validOutput.qa,
        evidenceBindings: [
          { claim: "test", evidenceRefs: [{ kind: "span", id: "invented:id:123" }] },
        ],
      },
    };
    expect(() => parseNarrative(JSON.stringify(bad), meta, rsFixture)).toThrow(
      "NarrativeValidationError",
    );
  });

  it("accepts empty evidenceBindings when noAnswerReason is set", () => {
    const unanswerable = {
      ...validOutput,
      qa: {
        ...validOutput.qa,
        answer: "Cannot determine from available evidence.",
        evidenceBindings: [],
        noAnswerReason: "Insufficient trace data.",
      },
    };
    const result = parseNarrative(JSON.stringify(unanswerable), meta, rsFixture);
    expect(result.qa.noAnswerReason).toBe("Insufficient trace data.");
  });
});
