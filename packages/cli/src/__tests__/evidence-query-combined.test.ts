/**
 * Tests for the combined LLM path in buildManualEvidenceQueryAnswer.
 *
 * For subprocess providers (codex, claude-code), a single generateEvidenceCombined()
 * call replaces the two-call plan+generate sequence to reduce latency.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvidenceResponse } from "3am-core";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const {
  mockGenerateEvidenceCombined,
  mockGenerateEvidencePlan,
  mockGenerateEvidenceQuery,
} = vi.hoisted(() => ({
  mockGenerateEvidenceCombined: vi.fn(),
  mockGenerateEvidencePlan: vi.fn(),
  mockGenerateEvidenceQuery: vi.fn(),
}));

vi.mock("3am-diagnosis", async () => {
  const actual = await vi.importActual("3am-diagnosis");
  return {
    ...actual,
    generateEvidenceCombined: mockGenerateEvidenceCombined,
    generateEvidencePlan: mockGenerateEvidencePlan,
    generateEvidenceQuery: mockGenerateEvidenceQuery,
  };
});

import { runManualEvidenceQuery } from "../commands/manual-execution.js";
import { rateLimit as diagnosisResult } from "../../../diagnosis/src/__fixtures__/diagnosis-results.js";

// ── Minimal evidence fixture ──────────────────────────────────────────────────
const minimalEvidence: EvidenceResponse = {
  surfaces: {
    traces: {
      observed: [
        {
          traceId: "trace-1",
          route: "/checkout",
          spans: [
            {
              spanId: "span-1",
              name: "checkout",
              status: "error",
              durationMs: 5000,
              attributes: { "http.response.status_code": 504 },
            },
          ],
        },
      ],
    },
    metrics: {
      hypotheses: [
        {
          id: "hyp-trigger",
          claim: "Error rate spiked to 68% at 14:23",
          verdict: "confirmed",
          metrics: [{ name: "error_rate", value: 68, expected: 1 }],
        },
      ],
    },
    logs: {
      claims: [
        {
          id: "log-retry",
          type: "cluster",
          label: "Retry storm",
          count: 450,
          entries: [{ body: "payment API returned 429, retrying in 100ms" }],
          explanation: "Fixed-interval retries without backoff",
        },
      ],
    },
  },
};

const baseOptions = {
  receiverUrl: "http://localhost:3333",
  incidentId: "inc_000001",
  question: "Why are checkouts failing?",
  history: [] as Array<{ role: "user" | "assistant"; content: string }>,
  provider: "codex" as const,
  diagnosisResult,
  evidence: minimalEvidence,
};

describe("evidence query — combined path (subprocess providers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls generateEvidenceCombined (not plan+generate) for codex provider", async () => {
    mockGenerateEvidenceCombined.mockResolvedValue({
      kind: "answer",
      response: {
        question: baseOptions.question,
        status: "answered",
        segments: [
          {
            id: "seg_1",
            kind: "fact",
            text: "Checkout spans are returning 504 due to worker pool exhaustion.",
            evidenceRefs: [{ kind: "span", id: "trace-1:span-1" }],
          },
        ],
        evidenceSummary: { traces: 1, metrics: 1, logs: 1 },
        followups: [],
      },
    });

    await runManualEvidenceQuery(baseOptions);

    expect(mockGenerateEvidenceCombined).toHaveBeenCalledOnce();
    expect(mockGenerateEvidencePlan).not.toHaveBeenCalled();
    expect(mockGenerateEvidenceQuery).not.toHaveBeenCalled();
  });

  it("calls generateEvidenceCombined for claude-code provider", async () => {
    mockGenerateEvidenceCombined.mockResolvedValue({
      kind: "answer",
      response: {
        question: baseOptions.question,
        status: "answered",
        segments: [
          {
            id: "seg_1",
            kind: "inference",
            text: "The rate limit cascade caused the failure.",
            evidenceRefs: [{ kind: "metric_group", id: "hyp-trigger" }],
          },
        ],
        evidenceSummary: { traces: 1, metrics: 1, logs: 1 },
        followups: [],
      },
    });

    await runManualEvidenceQuery({ ...baseOptions, provider: "claude-code" });

    expect(mockGenerateEvidenceCombined).toHaveBeenCalledOnce();
    expect(mockGenerateEvidencePlan).not.toHaveBeenCalled();
    expect(mockGenerateEvidenceQuery).not.toHaveBeenCalled();
  });

  it("returns clarification status when combined result is clarification (non-system followup)", async () => {
    mockGenerateEvidenceCombined.mockResolvedValue({
      kind: "clarification",
      clarificationQuestion: "Are you asking about checkout or payment?",
    });

    const result = await runManualEvidenceQuery(baseOptions);

    expect(result.status).toBe("clarification");
    expect(result.clarificationQuestion).toBe("Are you asking about checkout or payment?");
  });

  it("falls through to fallback answer when combined returns clarification on system followup", async () => {
    mockGenerateEvidenceCombined.mockResolvedValue({
      kind: "clarification",
      clarificationQuestion: "Which service?",
    });

    const result = await runManualEvidenceQuery({ ...baseOptions, isSystemFollowup: true });

    // Must NOT return clarification for system followups
    expect(result.status).not.toBe("clarification");
  });

  it("falls back to two-call path when combined call throws", async () => {
    mockGenerateEvidenceCombined.mockRejectedValue(new Error("subprocess failed"));
    mockGenerateEvidencePlan.mockResolvedValue({
      mode: "answer",
      rewrittenQuestion: "Why are checkout requests returning 504?",
      preferredSurfaces: ["traces", "metrics"],
    });
    mockGenerateEvidenceQuery.mockResolvedValue({
      question: baseOptions.question,
      status: "answered",
      segments: [
        {
          id: "seg_1",
          kind: "fact",
          text: "Worker pool exhausted.",
          evidenceRefs: [{ kind: "span", id: "trace-1:span-1" }],
        },
      ],
      evidenceSummary: { traces: 1, metrics: 1, logs: 1 },
      followups: [],
    });

    const result = await runManualEvidenceQuery(baseOptions);

    expect(mockGenerateEvidenceCombined).toHaveBeenCalledOnce();
    expect(mockGenerateEvidencePlan).toHaveBeenCalledOnce();
    expect(mockGenerateEvidenceQuery).toHaveBeenCalledOnce();
    expect(result.status).toBe("answered");
  });

  it("uses the two-call path (not combined) for anthropic provider", async () => {
    mockGenerateEvidencePlan.mockResolvedValue({
      mode: "answer",
      rewrittenQuestion: "Why are checkout requests failing?",
      preferredSurfaces: ["traces"],
    });
    mockGenerateEvidenceQuery.mockResolvedValue({
      question: baseOptions.question,
      status: "answered",
      segments: [
        {
          id: "seg_1",
          kind: "fact",
          text: "Checkout spans are returning 504.",
          evidenceRefs: [{ kind: "span", id: "trace-1:span-1" }],
        },
      ],
      evidenceSummary: { traces: 1, metrics: 1, logs: 1 },
      followups: [],
    });

    await runManualEvidenceQuery({ ...baseOptions, provider: "anthropic" });

    expect(mockGenerateEvidenceCombined).not.toHaveBeenCalled();
    expect(mockGenerateEvidencePlan).toHaveBeenCalledOnce();
    expect(mockGenerateEvidenceQuery).toHaveBeenCalledOnce();
  });

  it("uses the two-call path for openai provider", async () => {
    mockGenerateEvidencePlan.mockResolvedValue({
      mode: "answer",
      rewrittenQuestion: "Why are checkout requests failing?",
      preferredSurfaces: ["traces"],
    });
    mockGenerateEvidenceQuery.mockResolvedValue({
      question: baseOptions.question,
      status: "answered",
      segments: [
        {
          id: "seg_1",
          kind: "fact",
          text: "Checkout spans are returning 504.",
          evidenceRefs: [{ kind: "span", id: "trace-1:span-1" }],
        },
      ],
      evidenceSummary: { traces: 1, metrics: 1, logs: 1 },
      followups: [],
    });

    await runManualEvidenceQuery({ ...baseOptions, provider: "openai" });

    expect(mockGenerateEvidenceCombined).not.toHaveBeenCalled();
    expect(mockGenerateEvidencePlan).toHaveBeenCalledOnce();
    expect(mockGenerateEvidenceQuery).toHaveBeenCalledOnce();
  });

  it("returns a greeting no-answer without calling any LLM", async () => {
    const result = await runManualEvidenceQuery({ ...baseOptions, question: "hello" });

    expect(mockGenerateEvidenceCombined).not.toHaveBeenCalled();
    expect(mockGenerateEvidencePlan).not.toHaveBeenCalled();
    expect(mockGenerateEvidenceQuery).not.toHaveBeenCalled();
    expect(result.status).toBe("no_answer");
  });

  it("returns answered response with evidenceSummary populated", async () => {
    mockGenerateEvidenceCombined.mockResolvedValue({
      kind: "answer",
      response: {
        question: baseOptions.question,
        status: "answered",
        segments: [
          {
            id: "seg_1",
            kind: "fact",
            text: "Checkout spans are returning 504.",
            evidenceRefs: [{ kind: "span", id: "trace-1:span-1" }],
          },
        ],
        evidenceSummary: { traces: 0, metrics: 0, logs: 0 }, // will be overwritten
        followups: [],
      },
    });

    const result = await runManualEvidenceQuery(baseOptions);

    // evidenceSummary is always rebuilt from actual evidence, not from model output
    expect(result.evidenceSummary.traces).toBe(1);
    expect(result.evidenceSummary.metrics).toBe(1);
    expect(result.evidenceSummary.logs).toBe(1);
  });
});
