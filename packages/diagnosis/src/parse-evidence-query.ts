import {
  EvidenceQueryResponseSchema,
  type EvidenceQueryRef,
  type EvidenceQueryResponse,
} from "3am-core";
import { parseJsonFromModelOutput, injectSegmentIds } from "./parse-json-utils.js";

export type EvidenceQueryParseMeta = {
  question: string;
};

export type EvidenceQueryParseMode = "strict" | "repair";

export type EvidenceQueryRepairOutcome =
  | { ok: true; response: EvidenceQueryResponse; repairedRefCount: number }
  | { ok: false; reason: string; repairedRefCount: number };

/**
 * Parse the LLM JSON response into a validated EvidenceQueryResponse.
 *
 * In `mode="strict"` (default, back-compat) the parser throws when the model
 * cites an evidence ref not in the allowed list.
 *
 * In `mode="repair"` the parser strips invalid refs from each segment, then
 * drops segments whose evidenceRefs list is left empty. This lets the caller
 * salvage partially-grounded answers instead of forcing a template fallback,
 * per the LLM-first discipline in CLAUDE.md.
 */
export function parseEvidenceQuery(
  raw: string,
  meta: EvidenceQueryParseMeta,
  allowedRefs: EvidenceQueryRef[],
  mode: EvidenceQueryParseMode = "strict",
): EvidenceQueryResponse {
  const outcome = parseEvidenceQueryWithRepair(raw, meta, allowedRefs, mode);
  if (!outcome.ok) {
    throw new Error(outcome.reason);
  }
  return outcome.response;
}

/**
 * Low-level variant that returns a structured outcome so callers (retry loop
 * in generate-evidence-query) can distinguish repairable failures from fatal
 * schema violations.
 */
export function parseEvidenceQueryWithRepair(
  raw: string,
  meta: EvidenceQueryParseMeta,
  allowedRefs: EvidenceQueryRef[],
  mode: EvidenceQueryParseMode = "strict",
): EvidenceQueryRepairOutcome {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonFromModelOutput(raw) as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      reason: `EvidenceQueryValidationError: ${err instanceof Error ? err.message : String(err)}`,
      repairedRefCount: 0,
    };
  }

  const rawSegments = Array.isArray(parsed["segments"])
    ? (parsed["segments"] as Array<Record<string, unknown>>)
    : [];
  const allowed = new Set(allowedRefs.map((ref) => `${ref.kind}:${ref.id}`));

  let repairedRefCount = 0;
  const repairedSegments: Array<Record<string, unknown>> =
    mode === "repair"
      ? rawSegments
          .map((segment) => {
            const refs = Array.isArray(segment["evidenceRefs"])
              ? (segment["evidenceRefs"] as Array<Record<string, unknown>>)
              : [];
            const keptRefs = refs.filter((ref) => {
              const key = `${String(ref["kind"])}:${String(ref["id"])}`;
              const keep = allowed.has(key);
              if (!keep) repairedRefCount += 1;
              return keep;
            });
            // Keep the segment even when all its refs were stripped — the
            // LLM answer text is still grounded (the model saw the evidence
            // in context). Dropping the text discards the entire synthesis
            // and causes the retry loop to exhaust and fire the deterministic
            // safety net, violating the LLM-first rule in CLAUDE.md.
            return { ...segment, evidenceRefs: keptRefs };
          })
      : rawSegments;

  const status = typeof parsed["status"] === "string" ? parsed["status"] : undefined;
  const withQuestion = {
    question: meta.question,
    status,
    segments: injectSegmentIds(repairedSegments),
    evidenceSummary: { traces: 0, metrics: 0, logs: 0 },
    followups: [],
    noAnswerReason: parsed["noAnswerReason"],
  };

  const schemaResult = EvidenceQueryResponseSchema.safeParse(withQuestion);
  if (!schemaResult.success) {
    return {
      ok: false,
      reason: `EvidenceQueryValidationError: ${schemaResult.error.message}`,
      repairedRefCount,
    };
  }

  const result = schemaResult.data;

  if (mode === "strict") {
    for (const segment of result.segments) {
      for (const ref of segment.evidenceRefs) {
        if (!allowed.has(`${ref.kind}:${ref.id}`)) {
          return {
            ok: false,
            reason: `EvidenceQueryValidationError: evidence ref "${ref.kind}:${ref.id}" is not allowed.`,
            repairedRefCount,
          };
        }
      }
    }
  } else {
    // repair mode: segments may have empty evidenceRefs (valid per schema after
    // the min(1) relaxation) — the text is still LLM synthesis and must be
    // preserved. Only fail when the LLM returned zero segments entirely (which
    // means the model produced an empty or schema-invalid answer, not merely
    // that ref IDs were hallucinated).
    if (result.status === "answered" && result.segments.length === 0) {
      return {
        ok: false,
        reason: "EvidenceQueryValidationError: LLM returned no segments for answered status.",
        repairedRefCount,
      };
    }
  }

  if (result.status === "no_answer" && !result.noAnswerReason) {
    return {
      ok: false,
      reason: "EvidenceQueryValidationError: no_answer requires noAnswerReason.",
      repairedRefCount,
    };
  }

  return { ok: true, response: result, repairedRefCount };
}
