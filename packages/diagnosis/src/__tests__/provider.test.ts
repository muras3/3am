import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ProviderResolutionError, resolveProvider } from "../provider.js";

const spawnSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

describe("resolveProvider", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    spawnSyncMock.mockReset();
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("auto-detects claude-code before codex when both binaries exist", async () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 0 });

    const resolved = await resolveProvider({
      model: "ignored",
      maxTokens: 128,
      env: {},
    });

    expect(resolved.provider.name).toBe("claude-code");
    expect(resolved.source).toBe("autodetect");
  });

  it("auto-detects codex when claude is absent and codex exists", async () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 1 })
      .mockReturnValueOnce({ status: 0 });

    const resolved = await resolveProvider({
      model: "ignored",
      maxTokens: 128,
      env: {},
    });

    expect(resolved.provider.name).toBe("codex");
  });

  it("rejects subprocess providers when disabled", async () => {
    await expect(resolveProvider({
      provider: "claude-code",
      model: "ignored",
      maxTokens: 128,
      allowSubprocessProviders: false,
      env: {},
    })).rejects.toMatchObject<Partial<ProviderResolutionError>>({
      code: "PROVIDER_DISABLED",
    });
  });

  it("builds the OpenAI path under /v1", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const resolved = await resolveProvider({
      provider: "openai",
      model: "gpt-4o-mini",
      maxTokens: 64,
      env: { OPENAI_API_KEY: "test-key" },
    });
    await resolved.provider.generate([{ role: "user", content: "hello" }], {
      provider: "openai",
      model: "gpt-4o-mini",
      maxTokens: 64,
      env: { OPENAI_API_KEY: "test-key" },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ href: "https://api.openai.com/v1/chat/completions" }),
      expect.anything(),
    );
  });
});
