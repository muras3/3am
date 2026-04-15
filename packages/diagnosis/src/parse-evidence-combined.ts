import {
  EvidenceQueryResponseSchema,
  type EvidenceQueryRef,
  type EvidenceQueryResponse,
} from "3am-core";
import { parseJsonFromModelOutput, injectSegmentIds } from "./parse-json-utils.js";

export type EvidenceCombinedResult =
  | { kind: "clarification"; clarificationQuestion: string }
  | { kind: "answer"; response: EvidenceQueryResponse };

export function parseEvidenceCombined(
  raw: string,
  meta: { question: string },
  allowedRefs: EvidenceQueryRef[],
): EvidenceCombinedResult {
  const parsed = parseJsonFromModelOutput(raw) as Record<string, unknown>;
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

  // Models occasionally emit "unknown" segments with empty evidenceRefs despite
  // the prompt requirement. Drop those segments rather than letting the entire
  // response fail Zod validation. A segment without backing evidence adds no
  // value, and dropping it preserves the rest of the answer.
  const injected = injectSegmentIds(parsed["segments"] ?? []);
  const validSegments = Array.isArray(injected)
    ? injected.filter((segment) => {
        if (!segment || typeof segment !== "object") return false;
        const refs = (segment as Record<string, unknown>)["evidenceRefs"];
        return Array.isArray(refs) && refs.length > 0;
      })
    : injected;

  const withQuestion = {
    question: meta.question,
    status: parsed["status"],
    segments: validSegments,
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
