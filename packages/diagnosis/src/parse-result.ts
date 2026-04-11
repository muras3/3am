import { DiagnosisResultSchema, type DiagnosisResult } from "@3am/core";

export type ResultMeta = {
  incidentId: string;
  packetId: string;
  model: string;
  promptVersion: string;
};

const MAX_CAUSAL_CHAIN = 8;
const MAX_WATCH_ITEMS = 10;
const MAX_OPERATOR_CHECKS = 10;
const MAX_STRING = 2000;
const MAX_DETAIL = 500;

function checkStr(path: string, value: string, max: number): void {
  if (value.length > max) {
    throw new Error(
      `DiagnosisOutputSizeError: ${path} is ${value.length} chars (max ${max})`
    );
  }
}

function validateOutputSize(result: DiagnosisResult): void {
  const { causal_chain } = result.reasoning;
  if (causal_chain.length > MAX_CAUSAL_CHAIN) {
    throw new Error(
      `DiagnosisOutputSizeError: causal_chain has ${causal_chain.length} steps (max ${MAX_CAUSAL_CHAIN})`
    );
  }

  const { watch_items, operator_checks } = result.operator_guidance;
  if (watch_items.length > MAX_WATCH_ITEMS) {
    throw new Error(
      `DiagnosisOutputSizeError: watch_items has ${watch_items.length} items (max ${MAX_WATCH_ITEMS})`
    );
  }
  if (operator_checks.length > MAX_OPERATOR_CHECKS) {
    throw new Error(
      `DiagnosisOutputSizeError: operator_checks has ${operator_checks.length} items (max ${MAX_OPERATOR_CHECKS})`
    );
  }

  checkStr("summary.what_happened", result.summary.what_happened, MAX_STRING);
  checkStr("summary.root_cause_hypothesis", result.summary.root_cause_hypothesis, MAX_STRING);
  checkStr("recommendation.immediate_action", result.recommendation.immediate_action, MAX_STRING);
  checkStr("recommendation.action_rationale_short", result.recommendation.action_rationale_short, MAX_STRING);
  checkStr("recommendation.do_not", result.recommendation.do_not, MAX_STRING);
  checkStr("confidence.confidence_assessment", result.confidence.confidence_assessment, MAX_STRING);
  checkStr("confidence.uncertainty", result.confidence.uncertainty, MAX_STRING);

  for (const [i, step] of causal_chain.entries()) {
    checkStr(`causal_chain[${i}].title`, step.title, MAX_STRING);
    checkStr(`causal_chain[${i}].detail`, step.detail, MAX_DETAIL);
  }

  for (const [i, item] of watch_items.entries()) {
    checkStr(`watch_items[${i}].label`, item.label, MAX_STRING);
    checkStr(`watch_items[${i}].state`, item.state, MAX_STRING);
    checkStr(`watch_items[${i}].status`, item.status, MAX_STRING);
  }

  for (const [i, check] of operator_checks.entries()) {
    checkStr(`operator_checks[${i}]`, check, MAX_STRING);
  }
}

/**
 * Extracts JSON from model output that may contain prose and/or code fences.
 *
 * Strategy (in order):
 *  1. Direct JSON.parse (clean output)
 *  2. Extract content from the first ```...``` code fence (handles prose before/after fence)
 *  3. Extract from first '{' to last '}' (handles prose wrapping raw JSON without fences)
 */
function extractJson(raw: string): unknown {
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

  throw new Error("Failed to parse model output as JSON");
}

export function parseResult(raw: string, meta: ResultMeta): DiagnosisResult {
  let parsed: unknown;

  try {
    parsed = extractJson(raw);
  } catch {
    throw new Error("Failed to parse model output as JSON");
  }

  const withMeta = {
    ...(parsed as Record<string, unknown>),
    metadata: {
      incident_id: meta.incidentId,
      packet_id: meta.packetId,
      model: meta.model,
      prompt_version: meta.promptVersion,
      created_at: new Date().toISOString(),
    },
  };

  // Throws ZodError if schema is not satisfied
  const result = DiagnosisResultSchema.parse(withMeta);

  // Throws Error if output size constraints are violated
  validateOutputSize(result);

  return result;
}
