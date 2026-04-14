import { EventEmitter } from "node:events";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { resolveProvider } from "../provider.js";
import type { ProviderResolutionError } from "../provider.js";

const spawnSyncMock = vi.fn();
const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
  spawn: spawnMock,
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

describe("ClaudeCodeProvider: ANTHROPIC_API_KEY env isolation", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    spawnMock.mockReset();
    // claude binary is available
    spawnSyncMock.mockReturnValue({ status: 0 });
    // Skip persistent pool in tests — tests mock spawn() directly
    process.env["CLAUDE_CODE_POOL_DISABLED"] = "1";
  });

  afterEach(() => {
    delete process.env["CLAUDE_CODE_POOL_DISABLED"];
  });

  function makeSpawnChild(stdout: string) {
    const stdin = { write: vi.fn(), end: vi.fn() };
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = stdoutEmitter;
    child.stderr = stderrEmitter;
    child.stdin = stdin;
    child.kill = vi.fn();
    // Emit stdout data and close asynchronously
    setImmediate(() => {
      stdoutEmitter.emit("data", Buffer.from(stdout));
      child.emit("close", 0);
    });
    return child;
  }

  it("strips ANTHROPIC_API_KEY from spawn env when options.env contains it", async () => {
    const child = makeSpawnChild("diagnosis result");
    spawnMock.mockReturnValue(child);

    const { provider } = await resolveProvider({
      provider: "claude-code",
      maxTokens: 128,
      env: { ANTHROPIC_API_KEY: "sk-secret", OTHER_VAR: "keep-me" },
    });

    await provider.generate([{ role: "user", content: "diagnose" }], {
      provider: "claude-code",
      maxTokens: 128,
      env: { ANTHROPIC_API_KEY: "sk-secret", OTHER_VAR: "keep-me" },
    });

    const spawnCallEnv = spawnMock.mock.calls[0][2].env as NodeJS.ProcessEnv;
    expect(spawnCallEnv["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(spawnCallEnv["OTHER_VAR"]).toBe("keep-me");
  });

  it("strips ANTHROPIC_API_KEY from spawn env when process.env contains it (no options.env)", async () => {
    const child = makeSpawnChild("diagnosis result");
    spawnMock.mockReturnValue(child);

    const originalKey = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "sk-from-process-env";
    try {
      const { provider } = await resolveProvider({
        provider: "claude-code",
        maxTokens: 128,
        // no options.env — falls back to process.env
      });

      await provider.generate([{ role: "user", content: "diagnose" }], {
        provider: "claude-code",
        maxTokens: 128,
      });

      const spawnCallEnv = spawnMock.mock.calls[0][2].env as NodeJS.ProcessEnv;
      expect(spawnCallEnv["ANTHROPIC_API_KEY"]).toBeUndefined();
    } finally {
      if (originalKey === undefined) {
        delete process.env["ANTHROPIC_API_KEY"];
      } else {
        process.env["ANTHROPIC_API_KEY"] = originalKey;
      }
    }
  });

  it("does NOT mutate the original options.env object", async () => {
    const child = makeSpawnChild("diagnosis result");
    spawnMock.mockReturnValue(child);

    const inputEnv: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-secret", SAFE: "yes" };

    const { provider } = await resolveProvider({
      provider: "claude-code",
      maxTokens: 128,
      env: inputEnv,
    });

    await provider.generate([{ role: "user", content: "diagnose" }], {
      provider: "claude-code",
      maxTokens: 128,
      env: inputEnv,
    });

    // The original env object must NOT have been mutated
    expect(inputEnv["ANTHROPIC_API_KEY"]).toBe("sk-secret");
  });

  it("does NOT mutate process.env when stripping ANTHROPIC_API_KEY", async () => {
    const child = makeSpawnChild("diagnosis result");
    spawnMock.mockReturnValue(child);

    const originalKey = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "sk-from-process-env";
    try {
      const { provider } = await resolveProvider({
        provider: "claude-code",
        maxTokens: 128,
      });

      await provider.generate([{ role: "user", content: "diagnose" }], {
        provider: "claude-code",
        maxTokens: 128,
      });

      // process.env must NOT have been mutated
      expect(process.env["ANTHROPIC_API_KEY"]).toBe("sk-from-process-env");
    } finally {
      if (originalKey === undefined) {
        delete process.env["ANTHROPIC_API_KEY"];
      } else {
        process.env["ANTHROPIC_API_KEY"] = originalKey;
      }
    }
  });
});

describe("CodexProvider: spawn env is NOT stripped", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    spawnMock.mockReset();
    // claude absent, codex always found (resolveProvider + generate each call checkBinary)
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      const binary = args[0];
      return { status: binary === "codex" ? 0 : 1 };
    });
  });

  function makeSpawnChild(stdout: string) {
    const stdin = { write: vi.fn(), end: vi.fn() };
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = stdoutEmitter;
    child.stderr = stderrEmitter;
    child.stdin = stdin;
    child.kill = vi.fn();
    setImmediate(() => {
      stdoutEmitter.emit("data", Buffer.from(stdout));
      child.emit("close", 0);
    });
    return child;
  }

  it("passes ANTHROPIC_API_KEY through to codex subprocess env", async () => {
    const child = makeSpawnChild("codex result");
    spawnMock.mockReturnValue(child);

    const { provider } = await resolveProvider({
      provider: "codex",
      maxTokens: 128,
      env: { ANTHROPIC_API_KEY: "sk-secret", OTHER: "val" },
    });

    await provider.generate([{ role: "user", content: "diagnose" }], {
      provider: "codex",
      maxTokens: 128,
      env: { ANTHROPIC_API_KEY: "sk-secret", OTHER: "val" },
    });

    const spawnCallEnv = spawnMock.mock.calls[0][2].env as NodeJS.ProcessEnv;
    // CodexProvider uses the default buildSpawnEnv — no stripping
    expect(spawnCallEnv["ANTHROPIC_API_KEY"]).toBe("sk-secret");
    expect(spawnCallEnv["OTHER"]).toBe("val");
  });

  it("maps 'codex-5.4' alias to 'gpt-5.4' and passes the resolved name to codex CLI", async () => {
    const child = makeSpawnChild("codex result");
    spawnMock.mockReturnValue(child);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const { provider } = await resolveProvider({
      provider: "codex",
      maxTokens: 128,
      env: {},
    });

    await provider.generate([{ role: "user", content: "diagnose" }], {
      provider: "codex",
      model: "codex-5.4",
      maxTokens: 128,
      env: {},
    });

    // The CLI should be called with the resolved model name
    const spawnCallArgs = spawnMock.mock.calls[0][1] as string[];
    const modelFlagIndex = spawnCallArgs.indexOf("--model");
    expect(modelFlagIndex).toBeGreaterThan(-1);
    expect(spawnCallArgs[modelFlagIndex + 1]).toBe("gpt-5.4");

    // A warning message should be printed to stderr
    const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderrOutput).toContain("mapped model 'codex-5.4' → 'gpt-5.4'");

    stderrSpy.mockRestore();
  });

  it("passes an unknown model name through unchanged", async () => {
    const child = makeSpawnChild("codex result");
    spawnMock.mockReturnValue(child);

    const { provider } = await resolveProvider({
      provider: "codex",
      maxTokens: 128,
      env: {},
    });

    await provider.generate([{ role: "user", content: "diagnose" }], {
      provider: "codex",
      model: "gpt-4o",
      maxTokens: 128,
      env: {},
    });

    const spawnCallArgs = spawnMock.mock.calls[0][1] as string[];
    const modelFlagIndex = spawnCallArgs.indexOf("--model");
    expect(modelFlagIndex).toBeGreaterThan(-1);
    expect(spawnCallArgs[modelFlagIndex + 1]).toBe("gpt-4o");
  });
});
