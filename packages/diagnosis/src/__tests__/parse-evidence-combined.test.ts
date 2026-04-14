import { describe, expect, it } from "vitest";
import { parseEvidenceCombined } from "../parse-evidence-combined.js";

describe("parseEvidenceCombined", () => {
  const allowedRefs = [
    { kind: "span" as const, id: "trace-1:span-1" },
    { kind: "metric_group" as const, id: "hyp-trigger" },
    { kind: "absence" as const, id: "missing-retry" },
  ];

  describe("clarification mode", () => {
    it("parses a clarification response", () => {
      const raw = JSON.stringify({
        mode: "clarification",
        clarificationQuestion: "Are you asking about the checkout service or the payment service?",
      });

      const result = parseEvidenceCombined(raw, { question: "What failed?" }, allowedRefs);
      expect(result.kind).toBe("clarification");
      if (result.kind === "clarification") {
        expect(result.clarificationQuestion).toBe("Are you asking about the checkout service or the payment service?");
      }
    });

    it("throws when clarificationQuestion is missing in clarification mode", () => {
      const raw = JSON.stringify({ mode: "clarification" });
      expect(() => parseEvidenceCombined(raw, { question: "Q?" }, allowedRefs)).toThrow(/clarificationQuestion/);
    });
  });

  describe("answer mode", () => {
    it("parses a grounded answer response", () => {
      const raw = JSON.stringify({
        mode: "answer",
        status: "answered",
        segments: [
          {
            id: "seg-1",
            kind: "fact",
            text: "Checkout spans are returning 504.",
            evidenceRefs: [{ kind: "span", id: "trace-1:span-1" }],
          },
        ],
      });

      const result = parseEvidenceCombined(raw, { question: "What failed?" }, allowedRefs);
      expect(result.kind).toBe("answer");
      if (result.kind === "answer") {
        expect(result.response.status).toBe("answered");
        expect(result.response.segments[0]?.kind).toBe("fact");
        expect(result.response.question).toBe("What failed?");
      }
    });

    it("injects question into response.question", () => {
      const raw = JSON.stringify({
        mode: "answer",
        status: "answered",
        segments: [
          {
            kind: "fact",
            text: "Error rate spiked.",
            evidenceRefs: [{ kind: "metric_group", id: "hyp-trigger" }],
          },
        ],
      });

      const result = parseEvidenceCombined(raw, { question: "Why did errors spike?" }, allowedRefs);
      expect(result.kind).toBe("answer");
      if (result.kind === "answer") {
        expect(result.response.question).toBe("Why did errors spike?");
      }
    });

    it("fills missing segment ids", () => {
      const raw = JSON.stringify({
        mode: "answer",
        status: "answered",
        segments: [
          {
            kind: "fact",
            text: "Checkout spans are returning 504.",
            evidenceRefs: [{ kind: "span", id: "trace-1:span-1" }],
          },
        ],
      });

      const result = parseEvidenceCombined(raw, { question: "What failed?" }, allowedRefs);
      expect(result.kind).toBe("answer");
      if (result.kind === "answer") {
        expect(result.response.segments[0]?.id).toBe("seg_1");
      }
    });

    it("parses action mode response", () => {
      const raw = JSON.stringify({
        mode: "action",
        status: "answered",
        segments: [
          {
            id: "seg-1",
            kind: "inference",
            text: "Disable the payment retry loop to stop amplifying the Stripe rate limit.",
            evidenceRefs: [{ kind: "metric_group", id: "hyp-trigger" }],
          },
        ],
      });

      const result = parseEvidenceCombined(raw, { question: "What should I do?" }, allowedRefs);
      expect(result.kind).toBe("answer");
    });

    it("parses no_answer status", () => {
      const raw = JSON.stringify({
        mode: "answer",
        status: "no_answer",
        segments: [],
        noAnswerReason: "The current evidence does not support a grounded answer.",
      });

      const result = parseEvidenceCombined(raw, { question: "Why?" }, allowedRefs);
      expect(result.kind).toBe("answer");
      if (result.kind === "answer") {
        expect(result.response.status).toBe("no_answer");
        expect(result.response.noAnswerReason).toBeTruthy();
      }
    });

    it("rejects invented evidence refs", () => {
      const raw = JSON.stringify({
        mode: "answer",
        status: "answered",
        segments: [
          {
            id: "seg-1",
            kind: "fact",
            text: "Something happened.",
            evidenceRefs: [{ kind: "span", id: "trace-99:span-99" }],
          },
        ],
      });

      expect(() => parseEvidenceCombined(raw, { question: "Q?" }, allowedRefs)).toThrow(/not allowed/);
    });

    it("requires noAnswerReason when status is no_answer", () => {
      const raw = JSON.stringify({
        mode: "answer",
        status: "no_answer",
        segments: [],
      });

      expect(() => parseEvidenceCombined(raw, { question: "Q?" }, allowedRefs)).toThrow(/noAnswerReason/);
    });

    it("throws on invalid mode", () => {
      const raw = JSON.stringify({ mode: "unknown" });
      expect(() => parseEvidenceCombined(raw, { question: "Q?" }, allowedRefs)).toThrow(/invalid mode/);
    });
  });

  describe("JSON extraction robustness", () => {
    it("parses JSON in a code fence", () => {
      const body = JSON.stringify({
        mode: "answer",
        status: "answered",
        segments: [
          {
            id: "seg-1",
            kind: "fact",
            text: "Checkout spans are returning 504.",
            evidenceRefs: [{ kind: "span", id: "trace-1:span-1" }],
          },
        ],
      });
      const raw = "Here is my analysis:\n```json\n" + body + "\n```";
      const result = parseEvidenceCombined(raw, { question: "What failed?" }, allowedRefs);
      expect(result.kind).toBe("answer");
    });

    it("parses bare JSON preceded by prose (no code fence)", () => {
      const body = JSON.stringify({
        mode: "clarification",
        clarificationQuestion: "Which service?",
      });
      const raw = "Let me clarify: " + body;
      const result = parseEvidenceCombined(raw, { question: "What failed?" }, allowedRefs);
      expect(result.kind).toBe("clarification");
    });
  });
});
