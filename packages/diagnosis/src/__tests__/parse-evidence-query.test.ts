import { describe, expect, it } from "vitest";
import {
  parseEvidenceQuery,
  parseEvidenceQueryWithRepair,
} from "../parse-evidence-query.js";

describe("parseEvidenceQuery", () => {
  const allowedRefs = [
    { kind: "span" as const, id: "trace-1:span-1" },
    { kind: "metric_group" as const, id: "hyp-trigger" },
    { kind: "absence" as const, id: "missing-retry" },
  ];

  it("parses grounded segments and injects the caller question", () => {
    const raw = JSON.stringify({
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

    const result = parseEvidenceQuery(raw, { question: "What failed?" }, allowedRefs);
    expect(result.question).toBe("What failed?");
    expect(result.status).toBe("answered");
    expect(result.segments[0]?.kind).toBe("fact");
  });

  it("fills missing segment ids from model output", () => {
    const raw = JSON.stringify({
      status: "answered",
      segments: [
        {
          kind: "fact",
          text: "Checkout spans are returning 504.",
          evidenceRefs: [{ kind: "span", id: "trace-1:span-1" }],
        },
      ],
    });

    const result = parseEvidenceQuery(raw, { question: "What failed?" }, allowedRefs);
    expect(result.segments[0]?.id).toBe("seg_1");
  });

  it("parses JSON in code fence preceded by prose (issue #350)", () => {
    const body = JSON.stringify({
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
    const raw = "Here is my analysis:\n```json\n" + body + "\n```\nHope that helps.";
    const result = parseEvidenceQuery(raw, { question: "What failed?" }, allowedRefs);
    expect(result.status).toBe("answered");
    expect(result.segments[0]?.kind).toBe("fact");
  });

  it("parses bare JSON preceded by prose (no code fence)", () => {
    const body = JSON.stringify({
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
    const raw = "Here is the result:\n" + body + "\nDone.";
    const result = parseEvidenceQuery(raw, { question: "What failed?" }, allowedRefs);
    expect(result.status).toBe("answered");
  });

  it("rejects invented evidence refs", () => {
    const raw = JSON.stringify({
      status: "answered",
      segments: [
        {
          id: "seg-1",
          kind: "fact",
          text: "Invented evidence.",
          evidenceRefs: [{ kind: "span", id: "trace-2:span-9" }],
        },
      ],
    });

    expect(() => parseEvidenceQuery(raw, { question: "Q?" }, allowedRefs)).toThrow(
      /not allowed/,
    );
  });

  it("requires noAnswerReason when status is no_answer", () => {
    const raw = JSON.stringify({
      status: "no_answer",
      segments: [],
    });

    expect(() => parseEvidenceQuery(raw, { question: "Q?" }, allowedRefs)).toThrow(
      /noAnswerReason/,
    );
  });
});

describe("parseEvidenceQueryWithRepair (mode='repair')", () => {
  const allowedRefs = [
    { kind: "span" as const, id: "trace-1:span-1" },
    { kind: "metric_group" as const, id: "hyp-trigger" },
  ];

  it("strips invalid refs and keeps the segment when at least one valid ref remains", () => {
    const raw = JSON.stringify({
      status: "answered",
      segments: [
        {
          id: "seg-1",
          kind: "fact",
          text: "mixed.",
          evidenceRefs: [
            { kind: "span", id: "trace-1:span-1" },
            { kind: "span", id: "trace-ghost:span-ghost" },
            { kind: "metric_group", id: "hyp-trigger" },
          ],
        },
      ],
    });

    const outcome = parseEvidenceQueryWithRepair(raw, { question: "Q?" }, allowedRefs, "repair");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.response.segments[0]?.evidenceRefs).toHaveLength(2);
      expect(outcome.repairedRefCount).toBe(1);
    }
  });

  it("drops segments whose refs were all invalid", () => {
    const raw = JSON.stringify({
      status: "answered",
      segments: [
        {
          id: "seg-1",
          kind: "fact",
          text: "good.",
          evidenceRefs: [{ kind: "span", id: "trace-1:span-1" }],
        },
        {
          id: "seg-2",
          kind: "fact",
          text: "hallucinated.",
          evidenceRefs: [{ kind: "span", id: "trace-ghost:span-ghost" }],
        },
      ],
    });

    const outcome = parseEvidenceQueryWithRepair(raw, { question: "Q?" }, allowedRefs, "repair");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.response.segments).toHaveLength(1);
      expect(outcome.response.segments[0]?.id).toBe("seg-1");
      expect(outcome.repairedRefCount).toBe(1);
    }
  });

  it("returns ok=false when every answered segment lost all its refs after repair", () => {
    const raw = JSON.stringify({
      status: "answered",
      segments: [
        {
          id: "seg-1",
          kind: "fact",
          text: "hallucinated.",
          evidenceRefs: [{ kind: "span", id: "trace-ghost:span-ghost" }],
        },
      ],
    });

    const outcome = parseEvidenceQueryWithRepair(raw, { question: "Q?" }, allowedRefs, "repair");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toMatch(/invalid refs|all segments/i);
      expect(outcome.repairedRefCount).toBe(1);
    }
  });
});
