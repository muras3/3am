import {
  resolveProviderCandidates,
  ProviderResolutionError,
  type ModelCallOptions,
  type ModelMessage,
} from "./provider.js";

export type ModelOptions = ModelCallOptions;

export async function callModel(
  prompt: string,
  options: ModelOptions,
): Promise<string> {
  return callModelMessages([{ role: "user", content: prompt }], options);
}

export async function callModelMessages(
  messages: ModelMessage[],
  options: ModelOptions,
): Promise<string> {
  const candidates = await resolveProviderCandidates(options);
  let lastError: unknown;

  for (const candidate of candidates) {
    try {
      return await candidate.provider.generate(messages, options);
    } catch (error) {
      lastError = error;
      if (
        candidate.source === "explicit"
        || !(error instanceof ProviderResolutionError)
        || error.code !== "PROVIDER_AUTH_MISSING"
      ) {
        throw error;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Provider autodetect exhausted all candidates");
}
