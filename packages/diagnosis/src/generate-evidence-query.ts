import type { EvidenceQueryRef, EvidenceQueryResponse } from "3am-core";
import { callModel } from "./model-client.js";
import {
  buildEvidenceQueryPrompt,
  type EvidenceQueryPromptInput,
} from "./evidence-query-prompt.js";
import { parseEvidenceQuery } from "./parse-evidence-query.js";
import { defaultModelForProvider, type ProviderName } from "./provider.js";

export type GenerateEvidenceQueryOptions = {
  model?: string;
  locale?: "en" | "ja";
  provider?: ProviderName;
  baseUrl?: string;
  allowSubprocessProviders?: boolean;
  allowLocalHttpProviders?: boolean;
};

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 2048;

export async function generateEvidenceQuery(
  input: EvidenceQueryPromptInput,
  options?: GenerateEvidenceQueryOptions,
): Promise<EvidenceQueryResponse> {
  const model = options?.model ?? defaultModelForProvider(options?.provider, DEFAULT_MODEL);
  const prompt = buildEvidenceQueryPrompt(input, { locale: options?.locale });
  const raw = await callModel(prompt, {
    provider: options?.provider,
    model,
    maxTokens: MAX_TOKENS,
    baseUrl: options?.baseUrl,
    allowSubprocessProviders: options?.allowSubprocessProviders,
    allowLocalHttpProviders: options?.allowLocalHttpProviders,
  });

  return parseEvidenceQuery(
    raw,
    { question: input.question },
    input.evidence.map(({ ref }) => ref as EvidenceQueryRef),
  );
}
