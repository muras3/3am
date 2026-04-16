import { z } from "zod";
import {
  EvidenceQueryResponseSchema,
  EvidenceQuerySegmentSchema,
  EvidenceQueryRefSchema,
  type EvidenceQueryRef,
  type EvidenceQueryResponse,
} from "3am-core";
import { parseJsonFromModelOutput, injectSegmentIds } from "./parse-json-utils.js";

/**
 * Repair-only schema variant: allows `evidenceRefs: []` on segments whose
 * ref IDs were all stripped as hallucinations. The LLM answer text is still
 * grounded (the model saw the curated evidence in context). This schema is
 * NOT exported and NEVER used in strict mode — the public contract enforced
 * by EvidenceQueryResponseSchema (min(1) on evidenceRefs) is unchanged.
 */
const RepairSegmentSchema = EvidenceQuerySegmentSchema.extend({
  evidenceRefs: z.array(EvidenceQueryRefSchema),
}).strict();
const RepairResponseSchema = EvidenceQueryResponseSchema.extend({
  segments: z.array(RepairSegmentSchema),
}).strict();

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
 * In `mode="repair"` the parser strips invalid refs from each segment and
 * preserves the segment text even when ALL of its refs were stripped (the LLM
 * answer is still grounded — the model saw the curated evidence in context).
 * Only fail when the LLM returned zero segments for an "answered" response.
 * This prevents the deterministic safety net from firing when the only problem
 * was hallucinated ref IDs, per the LLM-first rule in CLAUDE.md.
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

  /**
   * Map integer index → real EvidenceQueryRef.
   * The LLM now emits 1-based integer indices (e.g. [1, 3]) instead of
   * {kind, id} objects, eliminating UUID/hash hallucination at the source.
   * Index-based citation fix: see CLAUDE.md evidence-query P1 bug.
   */
  function mapIndexToRef(rawRef: unknown): EvidenceQueryRef | null {
    const idx = typeof rawRef === "number" ? rawRef : NaN;
    if (Number.isInteger(idx) && idx >= 1 && idx <= allowedRefs.length) {
      return allowedRefs[idx - 1]!;
    }
    return null;
  }

  let repairedRefCount = 0;
  const repairedSegments: Array<Record<string, unknown>> =
    mode === "repair"
      ? rawSegments.reduce<Array<Record<string, unknown>>>((acc, segment) => {
            const originalRefs = Array.isArray(segment["evidenceRefs"])
              ? (segment["evidenceRefs"] as unknown[])
              : null;
            // If the LLM emitted no evidenceRefs at all (absent or non-array),
            // the segment is a prompt violation — not an out-of-bounds-index case.
            // Drop it so the retry guard can fire rather than accepting
            // uncited text.
            if (originalRefs === null) return acc;
            const keptRefs: EvidenceQueryRef[] = [];
            for (const rawRef of originalRefs) {
              const mapped = mapIndexToRef(rawRef);
              if (mapped !== null) {
                keptRefs.push(mapped);
              } else {
                repairedRefCount += 1;
              }
            }
            // Keep the segment even when all its refs were stripped — the
            // LLM answer text is still grounded (the model saw the evidence
            // in context). Dropping the text discards the entire synthesis
            // and causes the retry loop to exhaust and fire the deterministic
            // safety net, violating the LLM-first rule in CLAUDE.md.
            acc.push({ ...segment, evidenceRefs: keptRefs });
            return acc;
          }, [])
      : rawSegments.map((segment) => {
          // strict mode: still map indices to real refs so schema validation works
          const originalRefs = Array.isArray(segment["evidenceRefs"])
            ? (segment["evidenceRefs"] as unknown[])
            : null;
          if (originalRefs === null) return segment;
          const mappedRefs: EvidenceQueryRef[] = [];
          for (const rawRef of originalRefs) {
            const mapped = mapIndexToRef(rawRef);
            if (mapped !== null) {
              mappedRefs.push(mapped);
            } else {
              repairedRefCount += 1;
            }
          }
          return { ...segment, evidenceRefs: mappedRefs };
        });

  // In strict mode, fail early if any index was out of bounds — before schema
  // validation, because the schema requires evidenceRefs.min(1) per segment and
  // would otherwise produce a less informative error message.
  if (mode === "strict" && repairedRefCount > 0) {
    return {
      ok: false,
      reason: `EvidenceQueryValidationError: ${repairedRefCount} evidence index/indices out of bounds (not in allowed range 1..${allowedRefs.length}).`,
      repairedRefCount,
    };
  }

  const status = typeof parsed["status"] === "string" ? parsed["status"] : undefined;
  const withQuestion = {
    question: meta.question,
    status,
    segments: injectSegmentIds(repairedSegments),
    evidenceSummary: { traces: 0, metrics: 0, logs: 0 },
    followups: [],
    noAnswerReason: parsed["noAnswerReason"],
  };

  // Repair mode uses a schema that permits empty evidenceRefs on segments —
  // the public EvidenceQueryResponseSchema still enforces min(1) for all other
  // callers (strict mode, API serialisation, etc.).
  const schema = mode === "repair" ? RepairResponseSchema : EvidenceQueryResponseSchema;
  const schemaResult = schema.safeParse(withQuestion);
  if (!schemaResult.success) {
    return {
      ok: false,
      reason: `EvidenceQueryValidationError: ${schemaResult.error.message}`,
      repairedRefCount,
    };
  }

  // z.array(T).min(1) and z.array(T) both infer as T[] in TypeScript (Zod v4).
  // The cast is structurally safe: RepairResponseSchema.segments is
  // EvidenceQuerySegment[] with the same shape; only runtime validation differs.
  const result = schemaResult.data as EvidenceQueryResponse;

  if (mode !== "strict") {
    // repair mode: segments may survive with empty evidenceRefs after stripping
    // hallucinated IDs (RepairResponseSchema allows this). The text is still LLM
    // synthesis and must be preserved per the LLM-first rule in CLAUDE.md.
    // Only fail when the LLM returned zero segments entirely, which means the
    // model produced a genuinely empty or schema-invalid answer.
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
