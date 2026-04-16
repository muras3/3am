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
          evidenceRefs: [1],
        },
      ],
    });

    const result = parseEvidenceQuery(raw, { question: "What failed?" }, allowedRefs);
    expect(result.question).toBe("What failed?");
    expect(result.status).toBe("answered");
    expect(result.segments[0]?.kind).toBe("fact");
    // Index 1 should map to the first allowedRef
    expect(result.segments[0]?.evidenceRefs[0]).toEqual({ kind: "span", id: "trace-1:span-1" });
  });

  it("fills missing segment ids from model output", () => {
    const raw = JSON.stringify({
      status: "answered",
      segments: [
        {
          kind: "fact",
          text: "Checkout spans are returning 504.",
          evidenceRefs: [1],
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
          evidenceRefs: [1],
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
          evidenceRefs: [1],
        },
      ],
    });
    const raw = "Here is the result:\n" + body + "\nDone.";
    const result = parseEvidenceQuery(raw, { question: "What failed?" }, allowedRefs);
    expect(result.status).toBe("answered");
  });

  it("rejects out-of-bounds evidence indices", () => {
    const raw = JSON.stringify({
      status: "answered",
      segments: [
        {
          id: "seg-1",
          kind: "fact",
          text: "Invented evidence.",
          evidenceRefs: [99],
        },
      ],
    });

    expect(() => parseEvidenceQuery(raw, { question: "Q?" }, allowedRefs)).toThrow(
      /out of bounds/,
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

  it("strips out-of-bounds indices and keeps the segment when at least one valid index remains", () => {
    // allowedRefs has 2 entries: index 1 = span, index 2 = metric_group
    // Index 99 is out of bounds → stripped
    const raw = JSON.stringify({
      status: "answered",
      segments: [
        {
          id: "seg-1",
          kind: "fact",
          text: "mixed.",
          evidenceRefs: [1, 99, 2],
        },
      ],
    });

    const outcome = parseEvidenceQueryWithRepair(raw, { question: "Q?" }, allowedRefs, "repair");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.response.segments[0]?.evidenceRefs).toHaveLength(2);
      expect(outcome.response.segments[0]?.evidenceRefs[0]).toEqual({ kind: "span", id: "trace-1:span-1" });
      expect(outcome.response.segments[0]?.evidenceRefs[1]).toEqual({ kind: "metric_group", id: "hyp-trigger" });
      expect(outcome.repairedRefCount).toBe(1);
    }
  });

  it("keeps both segments when one has all-invalid indices — text from both is preserved", () => {
    // After the LLM-first fix: segments with empty refs survive repair.
    // The grounded text is still valuable even without valid ref indices.
    const raw = JSON.stringify({
      status: "answered",
      segments: [
        {
          id: "seg-1",
          kind: "fact",
          text: "good.",
          evidenceRefs: [1],
        },
        {
          id: "seg-2",
          kind: "fact",
          text: "hallucinated refs but real text.",
          evidenceRefs: [99],
        },
      ],
    });

    const outcome = parseEvidenceQueryWithRepair(raw, { question: "Q?" }, allowedRefs, "repair");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.response.segments).toHaveLength(2);
      expect(outcome.response.segments[0]?.id).toBe("seg-1");
      expect(outcome.response.segments[0]?.evidenceRefs).toHaveLength(1);
      expect(outcome.response.segments[1]?.id).toBe("seg-2");
      expect(outcome.response.segments[1]?.evidenceRefs).toHaveLength(0);
      expect(outcome.repairedRefCount).toBe(1);
    }
  });

  it("keeps segment text when ALL indices were out-of-bounds after repair (LLM-first: text preserved)", () => {
    // Regression guard: previously this returned ok=false and triggered the
    // deterministic safety net, causing 100% no_answer on Vercel/CF (#420).
    // After the fix, the LLM answer text is preserved even when ref indices were
    // out of bounds — the synthesis result is still grounded (model saw evidence
    // in context).
    const raw = JSON.stringify({
      status: "answered",
      segments: [
        {
          id: "seg-1",
          kind: "fact",
          text: "hallucinated refs but real text.",
          evidenceRefs: [99],
        },
      ],
    });

    const outcome = parseEvidenceQueryWithRepair(raw, { question: "Q?" }, allowedRefs, "repair");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.response.status).toBe("answered");
      expect(outcome.response.segments).toHaveLength(1);
      expect(outcome.response.segments[0]?.text).toBe("hallucinated refs but real text.");
      expect(outcome.response.segments[0]?.evidenceRefs).toHaveLength(0);
      expect(outcome.repairedRefCount).toBe(1);
    }
  });

  it("returns ok=false only when answered response has zero segments (not just zero refs)", () => {
    // The safety-net trigger is zero segments, not zero refs.
    const raw = JSON.stringify({
      status: "answered",
      segments: [],
    });

    const outcome = parseEvidenceQueryWithRepair(raw, { question: "Q?" }, allowedRefs, "repair");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toMatch(/no segments/i);
    }
  });

  it("treats absent evidenceRefs field (not an array) as prompt violation — drops the segment", () => {
    // Distinct from hallucinated-ID case: if the LLM never emitted evidenceRefs,
    // it is a prompt violation (not a repair case) and the segment is dropped.
    // This prevents prompt-malformed outputs from bypassing ref grounding.
    const raw = JSON.stringify({
      status: "answered",
      segments: [
        {
          id: "seg-valid",
          kind: "fact",
          text: "Good segment with refs.",
          evidenceRefs: [1],
        },
        {
          id: "seg-no-refs-field",
          kind: "fact",
          text: "Segment that never had evidenceRefs at all.",
          // evidenceRefs is intentionally absent
        },
      ],
    });

    const outcome = parseEvidenceQueryWithRepair(raw, { question: "Q?" }, allowedRefs, "repair");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      // Only the segment that had refs survives
      expect(outcome.response.segments).toHaveLength(1);
      expect(outcome.response.segments[0]?.id).toBe("seg-valid");
    }
  });
});
