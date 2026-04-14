import {
  EvidenceQueryResponseSchema,
  type EvidenceQueryRef,
  type EvidenceQueryResponse,
} from "3am-core";

export type EvidenceCombinedResult =
  | { kind: "clarification"; clarificationQuestion: string }
  | { kind: "answer"; response: EvidenceQueryResponse };

/**
 * Extracts JSON from model output that may contain prose and/or code fences.
 * Same strategy as parse-evidence-query.ts.
 */
function parseJson(raw: string): unknown {
  // Attempt 1: direct parse
  try {
    return JSON.parse(raw);
  } catch {
    // continue
  }

  // Attempt 2: first code fence
  const fenceMatch = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/.exec(raw);
  if (fenceMatch?.[1] !== undefined) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // continue
    }
  }

  // Attempt 3: first '{' to last '}'
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      // fall through
    }
  }

  throw new Error("Failed to parse combined evidence output as JSON");
}

function withSegmentIds(parsedSegments: unknown): unknown {
  if (!Array.isArray(parsedSegments)) return parsedSegments;

  return parsedSegments.map((segment, index) => {
    if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
      return segment;
    }

    const record = segment as Record<string, unknown>;
    if (typeof record["id"] === "string" && record["id"].length > 0) {
      return record;
    }

    return {
      ...record,
      id: `seg_${index + 1}`,
    };
  });
}

export function parseEvidenceCombined(
  raw: string,
  meta: { question: string },
  allowedRefs: EvidenceQueryRef[],
): EvidenceCombinedResult {
  const parsed = parseJson(raw) as Record<string, unknown>;
  const mode = parsed["mode"];

  // Shape A: clarification
  if (mode === "clarification") {
    const clarificationQuestion = parsed["clarificationQuestion"];
    if (typeof clarificationQuestion !== "string" || clarificationQuestion.trim().length === 0) {
      throw new Error("EvidenceCombinedValidationError: clarificationQuestion is required for clarification mode.");
    }
    return { kind: "clarification", clarificationQuestion: clarificationQuestion.trim() };
  }

  // Shape B: answer / action / missing_evidence
  if (mode !== "answer" && mode !== "action" && mode !== "missing_evidence") {
    throw new Error(`EvidenceCombinedValidationError: invalid mode "${String(mode)}".`);
  }

  const withQuestion = {
    question: meta.question,
    status: parsed["status"],
    segments: withSegmentIds(parsed["segments"] ?? []),
    evidenceSummary: { traces: 0, metrics: 0, logs: 0 },
    followups: [],
    noAnswerReason: parsed["noAnswerReason"],
  };

  const result = EvidenceQueryResponseSchema.parse(withQuestion);
  const allowed = new Set(allowedRefs.map((ref) => `${ref.kind}:${ref.id}`));

  for (const segment of result.segments) {
    for (const ref of segment.evidenceRefs) {
      if (!allowed.has(`${ref.kind}:${ref.id}`)) {
        throw new Error(
          `EvidenceCombinedValidationError: evidence ref "${ref.kind}:${ref.id}" is not allowed.`,
        );
      }
    }
  }

  if (result.status === "no_answer" && !result.noAnswerReason) {
    throw new Error("EvidenceCombinedValidationError: no_answer requires noAnswerReason.");
  }

  return { kind: "answer", response: result };
}
