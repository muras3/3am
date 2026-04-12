import { describe, expect, it } from "vitest";
import { parseEvidenceQuery } from "../parse-evidence-query.js";

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
