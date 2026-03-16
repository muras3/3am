import Anthropic from "@anthropic-ai/sdk";

export type ModelOptions = {
  model: string;
  maxTokens: number;
};

export async function callModel(
  prompt: string,
  options: ModelOptions,
): Promise<string> {
  const client = new Anthropic({ timeout: 120_000, maxRetries: 2 });
  const response = await client.messages.create({
    model: options.model,
    max_tokens: options.maxTokens,
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
  });

  const texts = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text);
  if (texts.length === 0) {
    throw new Error("No text content in model response");
  }
  return texts.join("");
}
