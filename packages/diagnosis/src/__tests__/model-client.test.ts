import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

import { callModel } from "../model-client.js";
import Anthropic from "@anthropic-ai/sdk";

const AnthropicMock = vi.mocked(Anthropic);

const defaultOptions = { provider: "anthropic" as const, model: "claude-sonnet-4-6", maxTokens: 4096 };

beforeEach(() => {
  vi.clearAllMocks();
  process.env["ANTHROPIC_API_KEY"] = "test-key";
  mockCreate.mockResolvedValue({
    content: [{ type: "text", text: "response" }],
  });
});

describe("callModel", () => {
  it("instantiates Anthropic with timeout and maxRetries", async () => {
    await callModel("test prompt", defaultOptions);

    expect(AnthropicMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 120_000, maxRetries: 2 }),
    );
  });

  it("throws when response content array is empty", async () => {
    mockCreate.mockResolvedValue({ content: [] });

    await expect(callModel("test prompt", defaultOptions)).rejects.toThrow(
      /(anthropic returned an empty response|No text content in model response)/,
    );
  });
});
