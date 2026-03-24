import {
  EvidenceQueryResponseSchema,
  type EvidenceQueryRef,
  type EvidenceQueryResponse,
} from "@3amoncall/core";

export type EvidenceQueryParseMeta = {
  question: string;
};

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const match = /```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(raw);
    if (match?.[1] !== undefined) {
      return JSON.parse(match[1]);
    }
    throw new Error("Failed to parse evidence query output as JSON");
  }
}

export function parseEvidenceQuery(
  raw: string,
  meta: EvidenceQueryParseMeta,
  allowedRefs: EvidenceQueryRef[],
): EvidenceQueryResponse {
  const parsed = parseJson(raw) as Record<string, unknown>;
  const withQuestion = {
    question: meta.question,
    status: parsed["status"],
    segments: parsed["segments"] ?? [],
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
          `EvidenceQueryValidationError: evidence ref "${ref.kind}:${ref.id}" is not allowed.`,
        );
      }
    }
  }

  if (result.status === "no_answer" && !result.noAnswerReason) {
    throw new Error("EvidenceQueryValidationError: no_answer requires noAnswerReason.");
  }

  return result;
}
