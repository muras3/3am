import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the provider-driven model client. We simulate a sequence of raw LLM
// outputs per call and assert the retry/repair loop in
// generateEvidenceQueryWithMeta behaves per CLAUDE.md.

const { callModelMock } = vi.hoisted(() => ({
  callModelMock: vi.fn(),
}));

vi.mock("../model-client.js", () => ({
  callModel: callModelMock,
  callModelMessages: vi.fn(),
}));
vi.mock("../provider.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    defaultModelForProvider: vi.fn((_provider: unknown, fallback: string) => fallback),
    resolveProviderCandidates: vi.fn(),
  };
});

import { generateEvidenceQueryWithMeta } from "../generate-evidence-query.js";
import type { EvidenceQueryPromptInput } from "../evidence-query-prompt.js";

const baseInput: EvidenceQueryPromptInput = {
  question: "Why is checkout failing?",
  answerMode: "answer",
  intent: "general",
  preferredSurfaces: ["traces", "metrics", "logs"],
  diagnosis: null,
  evidence: [
    { ref: { kind: "span", id: "trace-1:span-1" }, surface: "traces", summary: "Checkout returned 504." },
    { ref: { kind: "metric_group", id: "hyp-err" }, surface: "metrics", summary: "Error rate spiked." },
  ],
};

describe("generateEvidenceQueryWithMeta — retry + repair loop", () => {
  beforeEach(() => {
    callModelMock.mockReset();
  });

  it("succeeds on first attempt with a valid response (retryCount=0)", async () => {
    callModelMock.mockResolvedValueOnce(
      JSON.stringify({
        status: "answered",
        segments: [
          {
            kind: "fact",
            text: "Checkout returned 504 responses.",
            evidenceRefs: [1],
          },
        ],
      }),
    );

    const { response, meta } = await generateEvidenceQueryWithMeta(baseInput);

    expect(response.status).toBe("answered");
    expect(meta.retryCount).toBe(0);
    expect(meta.repairedRefCount).toBe(0);
    expect(callModelMock).toHaveBeenCalledOnce();
  });

  it("repairs out-of-bounds indices in-place without retry (repairedRefCount > 0, retryCount=0)", async () => {
    callModelMock.mockResolvedValueOnce(
      JSON.stringify({
        status: "answered",
        segments: [
          {
            kind: "fact",
            text: "A.",
            evidenceRefs: [1, 99], // 1 is valid (index 1 = trace-1:span-1), 99 is out-of-bounds → stripped
          },
        ],
      }),
    );

    const { response, meta } = await generateEvidenceQueryWithMeta(baseInput);

    expect(response.segments[0]?.evidenceRefs).toHaveLength(1);
    expect(meta.retryCount).toBe(0);
    expect(meta.repairedRefCount).toBeGreaterThanOrEqual(1);
  });

  it("preserves answer text on first attempt when all refs are hallucinated (no retry, LLM-first regression guard)", async () => {
    // Regression test for #420: previously, all-invalid refs caused ok=false →
    // retry loop exhausted → deterministic safety net fired → 100% no_answer.
    // After the fix, the LLM answer text is preserved (empty evidenceRefs is
    // valid) and no retry is needed.
    callModelMock.mockResolvedValueOnce(
      JSON.stringify({
        status: "answered",
        segments: [
          {
            kind: "fact",
            text: "Checkout timed out after 30s.",
            evidenceRefs: [99], // out-of-bounds index → stripped, but text preserved
          },
        ],
      }),
    );

    const { response, meta } = await generateEvidenceQueryWithMeta(baseInput);

    expect(response.status).toBe("answered");
    expect(response.segments).toHaveLength(1);
    expect(response.segments[0]?.text).toBe("Checkout timed out after 30s.");
    expect(response.segments[0]?.evidenceRefs).toHaveLength(0);
    expect(meta.retryCount).toBe(0);
    expect(meta.repairedRefCount).toBe(1);
    // Only one LLM call needed — text is preserved on first attempt
    expect(callModelMock).toHaveBeenCalledOnce();
  });

  it("retries only when LLM returns answered with truly zero segments (not just empty refs)", async () => {
    // A truly empty segments array for answered status is the new retry trigger.
    callModelMock.mockResolvedValueOnce(
      JSON.stringify({ status: "answered", segments: [] }),
    );
    callModelMock.mockResolvedValueOnce(
      JSON.stringify({
        status: "answered",
        segments: [
          {
            kind: "fact",
            text: "Checkout returned 504.",
            evidenceRefs: [1],
          },
        ],
      }),
    );

    const { response, meta } = await generateEvidenceQueryWithMeta(baseInput);

    expect(response.status).toBe("answered");
    expect(meta.retryCount).toBe(1);
    expect(callModelMock).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting retries when every attempt returns answered with zero segments", async () => {
    // The safety-net trigger is now zero segments (not zero refs).
    const bad = JSON.stringify({ status: "answered", segments: [] });
    callModelMock.mockResolvedValueOnce(bad);
    callModelMock.mockResolvedValueOnce(bad);
    callModelMock.mockResolvedValueOnce(bad);

    await expect(generateEvidenceQueryWithMeta(baseInput)).rejects.toThrow(
      /EvidenceQueryValidationError/,
    );
    // attempt 0, retry 1, retry 2 = 3 total calls (maxRetries default = 2)
    expect(callModelMock).toHaveBeenCalledTimes(3);
  });

  it("retry 2 receives a trimmed evidence set (top-5) and strictRefReminder=true (triggered by empty segments, not empty refs)", async () => {
    const inputWithManyRefs: EvidenceQueryPromptInput = {
      ...baseInput,
      evidence: Array.from({ length: 8 }, (_, i) => ({
        ref: { kind: "span" as const, id: `trace-x:span-${i}` },
        surface: "traces" as const,
        summary: `span ${i}`,
      })),
    };

    // Retry is triggered by answered+empty segments (not by hallucinated refs)
    const bad = JSON.stringify({ status: "answered", segments: [] });
    callModelMock.mockResolvedValue(bad);

    await expect(generateEvidenceQueryWithMeta(inputWithManyRefs)).rejects.toThrow(
      /EvidenceQueryValidationError/,
    );

    // Verify the third (final retry) prompt includes the trimmed <valid_refs>
    // with exactly 5 index entries ("1, 2, 3, 4, 5"). The prompt string is the
    // first positional arg to callModel.
    expect(callModelMock).toHaveBeenCalledTimes(3);
    const finalPrompt = callModelMock.mock.calls[2]?.[0] as string;
    const validRefsMatch = /<valid_refs>([^<]*)<\/valid_refs>/.exec(finalPrompt);
    const refCount = (validRefsMatch?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean).length;
    expect(refCount).toBe(5);
    // Indices should be "1, 2, 3, 4, 5" (not kind:id strings)
    expect(validRefsMatch?.[1]?.trim()).toBe("1, 2, 3, 4, 5");
    expect(finalPrompt).toContain("STRICT RETRY REMINDER");
  });
});
