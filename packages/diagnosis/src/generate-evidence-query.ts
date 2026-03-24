import type { EvidenceQueryRef, EvidenceQueryResponse } from "@3amoncall/core";
import { callModel } from "./model-client.js";
import {
  buildEvidenceQueryPrompt,
  type EvidenceQueryPromptInput,
} from "./evidence-query-prompt.js";
import { parseEvidenceQuery } from "./parse-evidence-query.js";

export type GenerateEvidenceQueryOptions = {
  model?: string;
};

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 2048;

export async function generateEvidenceQuery(
  input: EvidenceQueryPromptInput,
  options?: GenerateEvidenceQueryOptions,
): Promise<EvidenceQueryResponse> {
  const model = options?.model ?? DEFAULT_MODEL;
  const prompt = buildEvidenceQueryPrompt(input);
  const raw = await callModel(prompt, { model, maxTokens: MAX_TOKENS });

  return parseEvidenceQuery(
    raw,
    { question: input.question },
    input.evidence.map(({ ref }) => ref as EvidenceQueryRef),
  );
}
