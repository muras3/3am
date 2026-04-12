import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock node:readline so promptConfirm() can be controlled in tests.
// The factory captures a mutable "answers" queue that tests can populate.
// ---------------------------------------------------------------------------

// answers[i] is the response string for the i-th readline.question() call.
const _rlAnswers: string[] = [];
let _rlCallIndex = 0;

vi.mock("node:readline", () => ({
  createInterface: vi.fn(() => ({
    question: (_msg: string, cb: (answer: string) => void) => {
      const answer = _rlAnswers[_rlCallIndex++] ?? "";
      cb(answer);
    },
    close: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Mock provider — replaces the real executor with a controllable fake
// ---------------------------------------------------------------------------

const mockProvider = {
  deploy: vi.fn(),
  setEnvVar: vi.fn(),
  cleanup: vi.fn(),
};

vi.mock("../commands/deploy/provider.js", () => ({
  createProvider: vi.fn(() => mockProvider),
}));

// ---------------------------------------------------------------------------
// Mock all other sub-modules before importing the orchestrator
// ---------------------------------------------------------------------------

vi.mock("../commands/deploy/platform.js", () => ({
  detectPlatformCli: vi.fn(),
  checkPlatformAuth: vi.fn(),
  promptPlatformSelection: vi.fn(),
}));

vi.mock("../commands/deploy/env-writer.js", () => ({
  updateAppEnv: vi.fn(),
  promptAuthToken: vi.fn(),
}));

vi.mock("../commands/shared/health.js", () => ({
  checkReceiver: vi.fn(),
  waitForReceiver: vi.fn(),
  createClaimTokenWithRetry: vi.fn(),
  buildClaimUrl: vi.fn((_baseUrl: string, token: string) => `https://test.vercel.app/#claim=${token}`),
}));

vi.mock("../commands/cloudflare-workers.js", () => ({
  connectCloudflareWorkerToReceiver: vi.fn(),
  updateCloudflareObservabilityConfig: vi.fn(),
}));

vi.mock("../commands/init/credentials.js", () => ({
  resolveApiKey: vi.fn(),
  loadCredentials: vi.fn(),
  saveCredentials: vi.fn(),
  getReceiverCredential: vi.fn((creds, platform) => creds.receivers?.[platform]),
  setReceiverCredential: vi.fn((creds, platform, receiver) => ({
    ...creds,
    receiverUrl: receiver.url,
    receiverAuthToken: receiver.authToken,
    receivers: {
      ...(creds.receivers ?? {}),
      [platform]: {
        url: receiver.url,
        authToken: receiver.authToken,
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
    },
  })),
}));

vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(() => "generated-uuid-token"),
}));

// ---------------------------------------------------------------------------
// Mock global fetch (used for locale sync)
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Import mocked dependencies
// ---------------------------------------------------------------------------

import {
  detectPlatformCli,
  checkPlatformAuth,
} from "../commands/deploy/platform.js";
import { updateAppEnv } from "../commands/deploy/env-writer.js";
import { waitForReceiver, createClaimTokenWithRetry } from "../commands/shared/health.js";
import { resolveApiKey, loadCredentials, saveCredentials } from "../commands/init/credentials.js";
import { connectCloudflareWorkerToReceiver } from "../commands/cloudflare-workers.js";
import { runDeploy } from "../commands/deploy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupHappyPathMocks(): void {
  vi.mocked(resolveApiKey).mockResolvedValue("sk-ant-test");
  vi.mocked(detectPlatformCli).mockReturnValue(true);
  vi.mocked(checkPlatformAuth).mockResolvedValue(true);
  vi.mocked(loadCredentials).mockReturnValue({});
  vi.mocked(saveCredentials).mockReturnValue(undefined);
  mockProvider.deploy.mockResolvedValue({ url: "https://test.vercel.app" });
  mockProvider.setEnvVar.mockResolvedValue(undefined);
  mockProvider.cleanup.mockReturnValue(undefined);
  vi.mocked(waitForReceiver).mockResolvedValue(true);
  vi.mocked(createClaimTokenWithRetry).mockResolvedValue({
    status: "ok",
    token: "claim-token",
    expiresAt: "2026-04-01T00:00:00.000Z",
  });
  vi.mocked(updateAppEnv).mockReturnValue({
    added: ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS"],
    updated: [],
    envPath: "/path/.env",
  });
  // Default: locale PUT succeeds
  mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => "" });
}

/** Set the readline answers queue for the next test. */
function setRlAnswers(...answers: string[]): void {
  _rlAnswers.length = 0;
  _rlAnswers.push(...answers);
  _rlCallIndex = 0;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("runDeploy()", () => {
  let stdoutChunks: string[];
  let stderrChunks: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    stdoutChunks = [];
    stderrChunks = [];
    _rlAnswers.length = 0;
    _rlCallIndex = 0;

    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

    // Reset provider mocks
    mockProvider.deploy.mockReset();
    mockProvider.setEnvVar.mockReset();
    mockProvider.cleanup.mockReset();

    // Reset fetch mock
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Error cases
  // -------------------------------------------------------------------------

  it("exits with error when no API key", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue(undefined);

    await runDeploy([], {
      yes: true,
      noInteractive: true,
      platform: "vercel",
    });

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(stderrChunks.join("")).toContain("ANTHROPIC_API_KEY is required");
  });

  it("exits with error when no platform in non-interactive mode", async () => {
    await runDeploy([], {
      yes: true,
      noInteractive: true,
    });

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(stderrChunks.join("")).toContain("--no-interactive requires");
  });

  it("exits with error when platform CLI is missing (vercel)", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue("sk-ant-test");
    vi.mocked(detectPlatformCli).mockReturnValue(false);

    await runDeploy([], {
      yes: true,
      noInteractive: true,
      platform: "vercel",
    });

    expect(process.exit).toHaveBeenCalledWith(1);
    const stderr = stderrChunks.join("");
    expect(stderr).toContain("vercel CLI is not installed");
    expect(stderr).toContain("npm i -g vercel");
  });

  it("exits with error when platform CLI is missing (cloudflare)", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue("sk-ant-test");
    vi.mocked(detectPlatformCli).mockReturnValue(false);

    await runDeploy([], {
      yes: true,
      noInteractive: true,
      platform: "cloudflare",
    });

    expect(process.exit).toHaveBeenCalledWith(1);
    const stderr = stderrChunks.join("");
    expect(stderr).toContain("wrangler CLI is not installed");
    expect(stderr).toContain("npm i -g wrangler");
  });

  it("exits with error when platform auth failed", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue("sk-ant-test");
    vi.mocked(detectPlatformCli).mockReturnValue(true);
    vi.mocked(checkPlatformAuth).mockResolvedValue(false);

    await runDeploy([], {
      yes: true,
      noInteractive: true,
      platform: "vercel",
    });

    expect(process.exit).toHaveBeenCalledWith(1);
    const stderr = stderrChunks.join("");
    expect(stderr).toContain("not logged in to vercel");
    expect(stderr).toContain("vercel login");
  });

  it("exits with error when deploy fails and calls cleanup", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue("sk-ant-test");
    vi.mocked(detectPlatformCli).mockReturnValue(true);
    vi.mocked(checkPlatformAuth).mockResolvedValue(true);
    vi.mocked(loadCredentials).mockReturnValue({});
    vi.mocked(saveCredentials).mockReturnValue(undefined);
    mockProvider.setEnvVar.mockResolvedValue(undefined);
    mockProvider.deploy.mockRejectedValue(
      new Error("vercel deploy exited with code 1"),
    );
    mockProvider.cleanup.mockReturnValue(undefined);

    await runDeploy([], {
      yes: true,
      noInteractive: true,
      platform: "vercel",
    });

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(stderrChunks.join("")).toContain("deploy failed");
    expect(mockProvider.cleanup).toHaveBeenCalled();
  });

  it("exits with error when --no-setup without --auth-token", async () => {
    await runDeploy([], {
      yes: true,
      noInteractive: true,
      platform: "vercel",
      noSetup: true,
    });

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(stderrChunks.join("")).toContain("--no-setup requires --auth-token");
  });

  // -------------------------------------------------------------------------
  // Provider interaction
  // -------------------------------------------------------------------------

  it("sets ANTHROPIC_API_KEY and RECEIVER_AUTH_TOKEN on platform before deploying", async () => {
    setupHappyPathMocks();

    await runDeploy([], {
      yes: true,
      noInteractive: true,
      platform: "vercel",
    });

    expect(mockProvider.setEnvVar).toHaveBeenCalledWith(
      "ANTHROPIC_API_KEY",
      "sk-ant-test",
    );
    expect(mockProvider.setEnvVar).toHaveBeenCalledWith(
      "RECEIVER_AUTH_TOKEN",
      "generated-uuid-token",
    );

    // Both setEnvVar calls must happen before deploy
    const setEnvOrders = mockProvider.setEnvVar.mock.invocationCallOrder;
    const deployOrder = mockProvider.deploy.mock.invocationCallOrder[0];
    for (const order of setEnvOrders) {
      expect(order).toBeLessThan(deployOrder!);
    }
  });

  it("syncs stored LLM settings to platform env before deploying", async () => {
    setupHappyPathMocks();
    vi.mocked(loadCredentials).mockReturnValue({
      llmMode: "manual",
      llmProvider: "codex",
      llmBridgeUrl: "http://127.0.0.1:4269",
    });

    await runDeploy([], {
      yes: true,
      noInteractive: true,
      platform: "vercel",
    });

    expect(mockProvider.setEnvVar).toHaveBeenCalledWith("LLM_MODE", "manual");
    expect(mockProvider.setEnvVar).toHaveBeenCalledWith("LLM_PROVIDER", "codex");
    expect(mockProvider.setEnvVar).toHaveBeenCalledWith("LLM_BRIDGE_URL", "http://127.0.0.1:4269");
  });

  it("passes projectName to the provider factory", async () => {
    setupHappyPathMocks();
    const { createProvider } = await import("../commands/deploy/provider.js");

    await runDeploy([], {
      yes: true,
      noInteractive: true,
      platform: "vercel",
      projectName: "3am-receiver-dev",
    });

    expect(vi.mocked(createProvider)).toHaveBeenCalledWith("vercel", {
      projectName: "3am-receiver-dev",
    });
  });

  // -------------------------------------------------------------------------
  // Confirmation flow
  // -------------------------------------------------------------------------

  it("does not deploy when user declines deploy confirmation", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue("sk-ant-test");
    vi.mocked(detectPlatformCli).mockReturnValue(true);
    vi.mocked(checkPlatformAuth).mockResolvedValue(true);

    setRlAnswers("n");

    await runDeploy([], { platform: "vercel" });

    expect(mockProvider.deploy).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("skips .env write and prints manual instructions when user declines", async () => {
    setupHappyPathMocks();
    setRlAnswers("y", "n");

    await runDeploy([], { platform: "vercel" });

    const calls = vi.mocked(updateAppEnv).mock.calls;
    const writeCalls = calls.filter((c) => !c[0].dryRun);
    expect(writeCalls).toHaveLength(0);

    const stdout = stdoutChunks.join("");
    expect(stdout).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(stdout).toContain("Authorization=Bearer");
  });

  // -------------------------------------------------------------------------
  // Readiness check timeout
  // -------------------------------------------------------------------------

  it("continues with warning when readiness check times out", async () => {
    setupHappyPathMocks();
    vi.mocked(waitForReceiver).mockResolvedValue(false);

    await runDeploy([], {
      yes: true,
      noInteractive: true,
      platform: "vercel",
    });

    expect(process.exit).not.toHaveBeenCalled();
    const stdout = stdoutChunks.join("");
    expect(stdout).toContain("Warning");
    expect(stdout).toContain("ready");
  });

  // -------------------------------------------------------------------------
  // Happy paths
  // -------------------------------------------------------------------------

  it("happy path: first deploy generates token and syncs to platform", async () => {
    setupHappyPathMocks();

    await runDeploy([], {
      yes: true,
      noInteractive: true,
      platform: "vercel",
    });

    expect(process.exit).not.toHaveBeenCalled();
    expect(mockProvider.deploy).toHaveBeenCalled();
    expect(mockProvider.setEnvVar).toHaveBeenCalledWith(
      "ANTHROPIC_API_KEY",
      "sk-ant-test",
    );
    expect(mockProvider.setEnvVar).toHaveBeenCalledWith(
      "RECEIVER_AUTH_TOKEN",
      "generated-uuid-token",
    );
    expect(waitForReceiver).toHaveBeenCalledWith(
      "https://test.vercel.app",
      60_000,
    );
    expect(saveCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ receiverAuthToken: "generated-uuid-token" }),
    );
    expect(saveCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        receiverAuthToken: "generated-uuid-token",
        receiverUrl: "https://test.vercel.app",
      }),
    );

    const calls = vi.mocked(updateAppEnv).mock.calls;
    const writeCall = calls.find((c) => !c[0].dryRun);
    expect(writeCall).toBeDefined();
    expect(writeCall![0].receiverUrl).toBe("https://test.vercel.app");
    expect(writeCall![0].authToken).toBe("generated-uuid-token");

    const stdout = stdoutChunks.join("");
    expect(stdout).toContain("Deploy complete");
    expect(stdout).toContain("https://test.vercel.app");
  });

  it("happy path: re-deploy uses stored token from credentials", async () => {
    setupHappyPathMocks();
    vi.mocked(loadCredentials).mockReturnValue({
      receivers: {
        vercel: {
          url: "https://test.vercel.app",
          authToken: "stored-token",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      },
    });

    await runDeploy([], {
      yes: true,
      noInteractive: true,
      platform: "vercel",
    });

    expect(process.exit).not.toHaveBeenCalled();
    expect(mockProvider.setEnvVar).toHaveBeenCalledWith(
      "RECEIVER_AUTH_TOKEN",
      "stored-token",
    );

    const calls = vi.mocked(updateAppEnv).mock.calls;
    const writeCall = calls.find((c) => !c[0].dryRun);
    expect(writeCall![0].authToken).toBe("stored-token");
  });

  it("uses a platform-specific token instead of reusing another platform receiver token", async () => {
    setupHappyPathMocks();
    mockProvider.deploy.mockResolvedValue({ url: "https://test.workers.dev" });
    vi.mocked(connectCloudflareWorkerToReceiver).mockResolvedValue({
      changed: true,
      workerName: "edge-app",
      configPath: "/repo/wrangler.jsonc",
    });
    vi.mocked(loadCredentials).mockReturnValue({
      receiverUrl: "https://test.vercel.app",
      receiverAuthToken: "vercel-token",
      receivers: {
        vercel: {
          url: "https://test.vercel.app",
          authToken: "vercel-token",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
        cloudflare: {
          url: "https://old.workers.dev",
          authToken: "cloudflare-token",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      },
    });

    await runDeploy([], {
      yes: true,
      noInteractive: true,
      platform: "cloudflare",
    });

    expect(mockProvider.setEnvVar).toHaveBeenCalledWith("RECEIVER_AUTH_TOKEN", "cloudflare-token");
    expect(saveCredentials).toHaveBeenLastCalledWith(
      expect.objectContaining({
        receiverUrl: "https://test.workers.dev",
        receiverAuthToken: "cloudflare-token",
        receivers: expect.objectContaining({
          vercel: expect.objectContaining({ authToken: "vercel-token" }),
          cloudflare: expect.objectContaining({
            url: "https://test.workers.dev",
            authToken: "cloudflare-token",
          }),
        }),
      }),
    );
  });

  it("does not reuse a legacy Vercel token for a first Cloudflare deploy", async () => {
    setupHappyPathMocks();
    mockProvider.deploy.mockResolvedValue({ url: "https://test.workers.dev" });
    vi.mocked(connectCloudflareWorkerToReceiver).mockResolvedValue({
      changed: true,
      workerName: "edge-app",
      configPath: "/repo/wrangler.jsonc",
    });
    vi.mocked(loadCredentials).mockReturnValue({
      receiverUrl: "https://test.vercel.app",
      receiverAuthToken: "vercel-token",
    });

    await runDeploy([], {
      yes: true,
      noInteractive: true,
      platform: "cloudflare",
    });

    expect(mockProvider.setEnvVar).toHaveBeenCalledWith("RECEIVER_AUTH_TOKEN", "generated-uuid-token");
  });

  it("--auth-token flag overrides stored token", async () => {
    setupHappyPathMocks();
    vi.mocked(loadCredentials).mockReturnValue({ receiverAuthToken: "stored-token" });

    await runDeploy([], {
      yes: true,
      noInteractive: true,
      platform: "vercel",
      authToken: "provided-token",
    });

    expect(process.exit).not.toHaveBeenCalled();
    expect(mockProvider.setEnvVar).toHaveBeenCalledWith(
      "RECEIVER_AUTH_TOKEN",
      "provided-token",
    );
    expect(saveCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ receiverAuthToken: "provided-token" }),
    );
    expect(saveCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ receiverAuthToken: "provided-token", receiverUrl: "https://test.vercel.app" }),
    );
  });

  it("connects the current Cloudflare Worker instead of writing .env", async () => {
    setupHappyPathMocks();
    mockProvider.deploy.mockResolvedValue({ url: "https://test.workers.dev" });
    vi.mocked(connectCloudflareWorkerToReceiver).mockResolvedValue({
      changed: true,
      workerName: "edge-app",
      configPath: "/repo/wrangler.jsonc",
    });

    await runDeploy([], {
      yes: true,
      noInteractive: true,
      platform: "cloudflare",
    });

    expect(vi.mocked(connectCloudflareWorkerToReceiver)).toHaveBeenCalledWith(
      process.cwd(),
      "https://test.workers.dev",
      "generated-uuid-token",
      { noInteractive: true },
    );
    expect(updateAppEnv).not.toHaveBeenCalled();
    expect(stdoutChunks.join("")).toContain("Worker:");
    expect(stdoutChunks.join("")).toContain("edge-app");
  });

  // -------------------------------------------------------------------------
  // JSON output
  // -------------------------------------------------------------------------

  it("--json: JSON on stdout, human text on stderr", async () => {
    setupHappyPathMocks();

    await runDeploy([], {
      yes: true,
      noInteractive: true,
      platform: "vercel",
      json: true,
    });

    expect(process.exit).not.toHaveBeenCalled();

    const stdoutText = stdoutChunks.join("");
    const stderrText = stderrChunks.join("");

    const parsed = JSON.parse(stdoutText) as {
      status: string;
      receiverUrl: string;
      authToken: string;
      envUpdated: boolean;
    };

    expect(parsed.status).toBe("deployed");
    expect(parsed.receiverUrl).toBe("https://test.vercel.app");
    expect(parsed.authToken).toBe("generated-uuid-token");
    expect(parsed.envUpdated).toBe(true);

    expect(stderrText).toContain("Deploying Receiver");
  });

  // -------------------------------------------------------------------------
  // Locale sync
  // -------------------------------------------------------------------------

  it("locale=ja: fires PUT /api/settings/locale with {locale:'ja'} after deploy", async () => {
    setupHappyPathMocks();
    vi.mocked(loadCredentials).mockReturnValue({ locale: "ja" });
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => "" });

    await runDeploy([], {
      yes: true,
      noInteractive: true,
      platform: "vercel",
    });

    expect(process.exit).not.toHaveBeenCalled();

    const localeCalls = mockFetch.mock.calls.filter(
      ([url]: [string]) => String(url).includes("/api/settings/locale"),
    );
    expect(localeCalls).toHaveLength(1);
    const [url, init] = localeCalls[0] as [string, RequestInit];
    expect(url).toBe("https://test.vercel.app/api/settings/locale");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ locale: "ja" });
  });

  it("locale sync PUT failure: deploy remains success and warning is emitted", async () => {
    setupHappyPathMocks();
    vi.mocked(loadCredentials).mockReturnValue({ locale: "ja" });
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "internal server error",
    });

    await runDeploy([], {
      yes: true,
      noInteractive: true,
      platform: "vercel",
    });

    expect(process.exit).not.toHaveBeenCalled();
    const stdout = stdoutChunks.join("");
    expect(stdout).toContain("Deploy complete");
    const all = stdout + stderrChunks.join("");
    expect(all).toContain("Warning");
    expect(all).toContain("locale sync failed");
    // Response body must NOT be included in warning output (avoid leaking HTML/JSON blobs)
    expect(all).not.toContain("internal server error");
  });

  it("locale sync 404: old receiver without locale API — silently skipped, no warning", async () => {
    setupHappyPathMocks();
    vi.mocked(loadCredentials).mockReturnValue({ locale: "ja" });
    mockFetch.mockResolvedValue({ ok: false, status: 404, text: async () => "Not Found" });

    await runDeploy([], {
      yes: true,
      noInteractive: true,
      platform: "vercel",
    });

    expect(process.exit).not.toHaveBeenCalled();
    const stdout = stdoutChunks.join("");
    expect(stdout).toContain("Deploy complete");
    // No warning emitted for 404 (old receiver compat)
    const all = stdout + stderrChunks.join("");
    expect(all).not.toContain("locale sync failed");
  });

  it("locale sync fetch throws: deploy remains success and warning is emitted", async () => {
    setupHappyPathMocks();
    vi.mocked(loadCredentials).mockReturnValue({ locale: "ja" });
    mockFetch.mockRejectedValue(new Error("network failure"));

    await runDeploy([], {
      yes: true,
      noInteractive: true,
      platform: "vercel",
    });

    expect(process.exit).not.toHaveBeenCalled();
    const stdout = stdoutChunks.join("");
    expect(stdout).toContain("Deploy complete");
    const all = stdout + stderrChunks.join("");
    expect(all).toContain("Warning");
    expect(all).toContain("locale sync failed");
  });

  it("locale not set: PUT is not called", async () => {
    setupHappyPathMocks();
    vi.mocked(loadCredentials).mockReturnValue({});

    await runDeploy([], {
      yes: true,
      noInteractive: true,
      platform: "vercel",
    });

    expect(process.exit).not.toHaveBeenCalled();
    const localeCalls = mockFetch.mock.calls.filter(
      ([url]: [string]) => String(url).includes("/api/settings/locale"),
    );
    expect(localeCalls).toHaveLength(0);
  });

  it("unsupported locale: PUT is not called, warning is emitted", async () => {
    setupHappyPathMocks();
    vi.mocked(loadCredentials).mockReturnValue({ locale: "fr" });

    await runDeploy([], {
      yes: true,
      noInteractive: true,
      platform: "vercel",
    });

    expect(process.exit).not.toHaveBeenCalled();
    const localeCalls = mockFetch.mock.calls.filter(
      ([url]: [string]) => String(url).includes("/api/settings/locale"),
    );
    expect(localeCalls).toHaveLength(0);
    const all = stdoutChunks.join("") + stderrChunks.join("");
    expect(all).toContain('locale "fr" is not supported');
  });
});
