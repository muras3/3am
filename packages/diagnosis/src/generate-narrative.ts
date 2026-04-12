import type {
  DiagnosisResult,
  ReasoningStructure,
  ConsoleNarrative,
} from "3am-core";
import { buildNarrativePrompt } from "./narrative-prompt.js";
import { parseNarrative } from "./parse-narrative.js";
import { callModel } from "./model-client.js";
import { defaultModelForProvider, type ProviderName } from "./provider.js";

export type GenerateNarrativeOptions = {
  /** Model to use for narrative generation. Defaults to claude-haiku-4-5-20251001. */
  model?: string;
  /** Prompt version identifier. Defaults to "narrative-v1". */
  promptVersion?: string;
  /** Output locale. "ja" appends Japanese language instruction. Defaults to "en". */
  locale?: "en" | "ja";
  provider?: ProviderName;
  baseUrl?: string;
  allowSubprocessProviders?: boolean;
  allowLocalHttpProviders?: boolean;
};

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_PROMPT_VERSION = "narrative-v1";
const MAX_TOKENS = 4096;

/**
 * Stage 2: Console Narrative Generation.
 *
 * Takes stage 1 DiagnosisResult + receiver's ReasoningStructure and
 * generates operator-readable narrative for the console UI.
 *
 * This function generates WORDING ONLY — no judgments, classifications,
 * or numeric values. All deterministic data comes from the inputs.
 */
export async function generateConsoleNarrative(
  diagnosisResult: DiagnosisResult,
  context: ReasoningStructure,
  options?: GenerateNarrativeOptions,
): Promise<ConsoleNarrative> {
  const model = options?.model ?? defaultModelForProvider(options?.provider, DEFAULT_MODEL);
  const modelLabel = model ?? `${options?.provider ?? "default"}-default`;
  const promptVersion = options?.promptVersion ?? DEFAULT_PROMPT_VERSION;

  const prompt = buildNarrativePrompt(diagnosisResult, context, { locale: options?.locale });
  const raw = await callModel(prompt, {
    provider: options?.provider,
    model,
    maxTokens: MAX_TOKENS,
    baseUrl: options?.baseUrl,
    allowSubprocessProviders: options?.allowSubprocessProviders,
    allowLocalHttpProviders: options?.allowLocalHttpProviders,
  });

  return parseNarrative(raw, {
    model: modelLabel,
    promptVersion,
    stage1PacketId: diagnosisResult.metadata.packet_id,
  }, context);
}
