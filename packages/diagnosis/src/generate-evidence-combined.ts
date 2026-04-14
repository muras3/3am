import { callModel } from "./model-client.js";
import { buildEvidenceCombinedPrompt, type EvidenceCombinedPromptInput } from "./evidence-combined-prompt.js";
import { parseEvidenceCombined, type EvidenceCombinedResult } from "./parse-evidence-combined.js";
import type { EvidenceQueryRef } from "3am-core";
import { defaultModelForProvider, type ProviderName } from "./provider.js";

export type GenerateEvidenceCombinedOptions = {
  model?: string;
  locale?: "en" | "ja";
  provider?: ProviderName;
  baseUrl?: string;
  allowSubprocessProviders?: boolean;
  allowLocalHttpProviders?: boolean;
};

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/**
 * Performs plan + generation in a single LLM call.
 *
 * For subprocess providers (codex, claude-code), each callModel() invocation
 * incurs 7-9s of subprocess startup overhead. By merging the plan step and
 * the generate step into one prompt, we cut total latency from 15-18s to 7-9s.
 *
 * The model is asked to:
 *   1. Classify intent (answer / action / missing_evidence / clarification)
 *   2. Generate grounded answer segments (or a clarification question)
 * ... in a single response.
 *
 * @param allowedRefs - Evidence refs the model is allowed to cite. Used for
 *   validation in parse-evidence-combined. Pass the full candidate set so the
 *   model can select the most relevant items internally.
 */
export async function generateEvidenceCombined(
  input: EvidenceCombinedPromptInput,
  allowedRefs: EvidenceQueryRef[],
  options?: GenerateEvidenceCombinedOptions,
): Promise<EvidenceCombinedResult> {
  const model = options?.model ?? defaultModelForProvider(options?.provider, DEFAULT_MODEL);
  const MAX_TOKENS = 2048;

  const prompt = buildEvidenceCombinedPrompt(input, { locale: options?.locale });
  const raw = await callModel(prompt, {
    provider: options?.provider,
    model,
    maxTokens: MAX_TOKENS,
    baseUrl: options?.baseUrl,
    allowSubprocessProviders: options?.allowSubprocessProviders,
    allowLocalHttpProviders: options?.allowLocalHttpProviders,
  });

  return parseEvidenceCombined(raw, { question: input.question }, allowedRefs);
}
