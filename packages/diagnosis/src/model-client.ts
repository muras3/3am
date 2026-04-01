import {
  resolveProvider,
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
  const { provider } = await resolveProvider(options);
  return provider.generate(messages, options);
}
