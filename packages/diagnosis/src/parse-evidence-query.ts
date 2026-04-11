import {
  EvidenceQueryResponseSchema,
  type EvidenceQueryRef,
  type EvidenceQueryResponse,
} from "3am-core";

export type EvidenceQueryParseMeta = {
  question: string;
};

/**
 * Extracts JSON from model output that may contain prose and/or code fences.
 *
 * Strategy (in order):
 *  1. Direct JSON.parse (clean output)
 *  2. Extract content from the first ```...``` code fence (handles prose before/after fence)
 *  3. Extract from first '{' to last '}' (handles prose wrapping raw JSON without fences)
 */
function parseJson(raw: string): unknown {
  // Attempt 1: direct parse
  try {
    return JSON.parse(raw);
  } catch {
    // continue
  }

  // Attempt 2: first code fence (allow any prose before/after)
  const fenceMatch = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/.exec(raw);
  if (fenceMatch?.[1] !== undefined) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // continue to attempt 3
    }
  }

  // Attempt 3: first '{' to last '}'
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      // fall through to throw
    }
  }

  throw new Error("Failed to parse evidence query output as JSON");
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

export function parseEvidenceQuery(
  raw: string,
  meta: EvidenceQueryParseMeta,
  allowedRefs: EvidenceQueryRef[],
): EvidenceQueryResponse {
  const parsed = parseJson(raw) as Record<string, unknown>;
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
