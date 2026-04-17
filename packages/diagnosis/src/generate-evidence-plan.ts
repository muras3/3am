import { callModel } from "./model-client.js";
import { buildEvidencePlanPrompt, type EvidencePlanPromptInput } from "./evidence-plan-prompt.js";
import { parseEvidencePlan, type EvidencePlan } from "./parse-evidence-plan.js";
import { defaultModelForProvider, type ProviderName } from "./provider.js";

export type GenerateEvidencePlanOptions = {
  model?: string;
  locale?: "en" | "ja";
  provider?: ProviderName;
  baseUrl?: string;
  allowSubprocessProviders?: boolean;
  allowLocalHttpProviders?: boolean;
};

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 600;

export async function generateEvidencePlan(
  input: EvidencePlanPromptInput,
  options?: GenerateEvidencePlanOptions,
): Promise<EvidencePlan> {
  const model = options?.model ?? defaultModelForProvider(options?.provider, DEFAULT_MODEL);
  const prompt = buildEvidencePlanPrompt(input, { locale: options?.locale });
  const raw = await callModel(prompt, {
    provider: options?.provider,
    model,
    maxTokens: MAX_TOKENS,
    baseUrl: options?.baseUrl,
    allowSubprocessProviders: options?.allowSubprocessProviders,
    allowLocalHttpProviders: options?.allowLocalHttpProviders,
  });
  return parseEvidencePlan(raw);
}
