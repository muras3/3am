import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const mockCreate = vi.fn();
const spawnSyncMock = vi.fn();
const spawnMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.messages = { create: mockCreate };
  }),
}));

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
  spawn: spawnMock,
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
  spawnSyncMock.mockReturnValue({ status: 1 });
  spawnMock.mockReset();
});

describe("callModel", () => {
  it("instantiates Anthropic with timeout and maxRetries", async () => {
    await callModel("test prompt", defaultOptions);

    expect(AnthropicMock).toHaveBeenCalledWith(
      expect.objectContaining({ maxRetries: 2 }),
    );
  });

  it("throws when response content array is empty", async () => {
    mockCreate.mockResolvedValue({ content: [] });

    await expect(callModel("test prompt", defaultOptions)).rejects.toThrow(
      /(anthropic returned an empty response|No text content in model response)/,
    );
  });

  it("falls back to claude-code on autodetect when ANTHROPIC_API_KEY is unauthorized", async () => {
    mockCreate.mockRejectedValue({ status: 401 });
    spawnSyncMock
      .mockReturnValueOnce({ status: 0 }) // autodetect: claude found
      .mockReturnValueOnce({ status: 1 }) // autodetect: codex not found
      .mockReturnValueOnce({ status: 0 }); // generate(): checkBinary("claude") again

    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: vi.fn(), end: vi.fn() };
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("subscription response"));
        child.emit("close", 0);
      });
      return child;
    });

    const result = await callModel("test prompt", {
      model: "claude-sonnet-4-6",
      maxTokens: 4096,
      env: { ANTHROPIC_API_KEY: "invalid-key" },
    });

    expect(result).toBe("subscription response");
    expect(spawnMock).toHaveBeenCalledWith(
      "claude",
      ["-p", "--model", "claude-sonnet-4-6"],
      expect.objectContaining({
        env: expect.not.objectContaining({ ANTHROPIC_API_KEY: expect.anything() }),
      }),
    );
  });

  it("strips ANTHROPIC_API_KEY when claude-code is explicitly selected", async () => {
    // checkBinary is called once in generate() (explicit provider skips resolveProvider binary check)
    spawnSyncMock.mockReturnValue({ status: 0 });
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: vi.fn(), end: vi.fn() };
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("explicit subscription response"));
        child.emit("close", 0);
      });
      return child;
    });

    const result = await callModel("test prompt", {
      provider: "claude-code",
      model: "claude-sonnet-4-6",
      maxTokens: 4096,
      env: { ...process.env, ANTHROPIC_API_KEY: "invalid-key" },
    });

    expect(result).toBe("explicit subscription response");
    expect(spawnMock).toHaveBeenCalledWith(
      "claude",
      ["-p", "--model", "claude-sonnet-4-6"],
      expect.objectContaining({
        env: expect.not.objectContaining({ ANTHROPIC_API_KEY: expect.anything() }),
      }),
    );
  });
});
