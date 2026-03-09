import Anthropic from "@anthropic-ai/sdk";

export type ModelOptions = {
  model: string;
  maxTokens: number;
};

export async function callModel(
  prompt: string,
  options: ModelOptions,
): Promise<string> {
  const client = new Anthropic();
  const response = await client.messages.create({
    model: options.model,
    max_tokens: options.maxTokens,
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
  });

  const block = response.content[0];
  if (block.type !== "text") {
    throw new Error(`Unexpected content block type: ${block.type}`);
  }
  return block.text;
}
