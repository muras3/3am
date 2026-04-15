import type { EvidenceQueryRef, EvidenceQueryResponse } from "3am-core";
import { callModel } from "./model-client.js";
import {
  buildEvidenceQueryPrompt,
  type EvidenceQueryPromptInput,
} from "./evidence-query-prompt.js";
import { parseEvidenceQueryWithRepair } from "./parse-evidence-query.js";
import { defaultModelForProvider, type ProviderName } from "./provider.js";

export type GenerateEvidenceQueryOptions = {
  model?: string;
  locale?: "en" | "ja";
  provider?: ProviderName;
  baseUrl?: string;
  allowSubprocessProviders?: boolean;
  allowLocalHttpProviders?: boolean;
  /**
   * Maximum retry attempts after the first call. Default: 2 (so up to 3
   * calls in the worst case). Set to 0 to preserve legacy single-call
   * behavior (used by combined-prompt).
   */
  maxRetries?: number;
};

/**
 * Metadata emitted by the retry-aware generator. Surfaced via
 * `generateEvidenceQueryWithMeta` for callers that want to observe how much
 * repair the synthesis required; the plain `generateEvidenceQuery` keeps the
 * original API (returns only the response).
 */
export type EvidenceQueryGenerationMeta = {
  retryCount: number;
  repairedRefCount: number;
};

export type EvidenceQueryGenerationResult = {
  response: EvidenceQueryResponse;
  meta: EvidenceQueryGenerationMeta;
};

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 2048;
const DEFAULT_MAX_RETRIES = 2;

export async function generateEvidenceQuery(
  input: EvidenceQueryPromptInput,
  options?: GenerateEvidenceQueryOptions,
): Promise<EvidenceQueryResponse> {
  const { response } = await generateEvidenceQueryWithMeta(input, options);
  return response;
}

/**
 * LLM-first evidence-query synthesis with a bounded retry + post-process
 * repair loop. Behavior:
 *
 *   attempt 0: call LLM with the provided prompt input.
 *   parse:     repair mode (strip invalid refs; drop empty segments).
 *   attempt 1: call again with strictRefReminder=true if attempt 0 output was
 *              unusable (zero segments after repair OR parse error).
 *   attempt 2: call again with temperature=0 and top-5 refs only.
 *
 * If every attempt fails, the function throws. Callers (domain layer) are
 * responsible for the final deterministic safety net.
 */
export async function generateEvidenceQueryWithMeta(
  input: EvidenceQueryPromptInput,
  options?: GenerateEvidenceQueryOptions,
): Promise<EvidenceQueryGenerationResult> {
  const model = options?.model ?? defaultModelForProvider(options?.provider, DEFAULT_MODEL);
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;

  let cumulativeRepaired = 0;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const attemptInput = buildAttemptInput(input, attempt);
    const attemptAllowedRefs = attemptInput.evidence.map(({ ref }) => ref as EvidenceQueryRef);
    const prompt = buildEvidenceQueryPrompt(attemptInput, { locale: options?.locale });

    try {
      const raw = await callModel(prompt, {
        provider: options?.provider,
        model,
        maxTokens: MAX_TOKENS,
        baseUrl: options?.baseUrl,
        allowSubprocessProviders: options?.allowSubprocessProviders,
        allowLocalHttpProviders: options?.allowLocalHttpProviders,
        temperature: attempt >= 2 ? 0 : undefined,
      });

      const outcome = parseEvidenceQueryWithRepair(
        raw,
        { question: input.question },
        attemptAllowedRefs,
        "repair",
      );

      if (outcome.ok) {
        cumulativeRepaired += outcome.repairedRefCount;
        return {
          response: outcome.response,
          meta: { retryCount: attempt, repairedRefCount: cumulativeRepaired },
        };
      }

      cumulativeRepaired += outcome.repairedRefCount;
      lastError = new Error(outcome.reason);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("generateEvidenceQuery: unknown failure after retries.");
}

function buildAttemptInput(
  input: EvidenceQueryPromptInput,
  attempt: number,
): EvidenceQueryPromptInput {
  if (attempt === 0) return input;
  if (attempt === 1) {
    return { ...input, strictRefReminder: true };
  }
  // attempt 2+: tighten the allowed ref set to the top-5 most-relevant entries
  // so the model has fewer ways to hallucinate an ID. (temperature=0 is
  // already the default in provider.ts, so the differentiator at this stage
  // is the narrower ref list, not the sampling config.)
  const trimmedEvidence = input.evidence.slice(0, 5);
  return { ...input, strictRefReminder: true, evidence: trimmedEvidence };
}
