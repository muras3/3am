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
  fetchSetupToken: vi.fn(),
}));

vi.mock("../commands/cloudflare-workers.js", () => ({
  connectCloudflareWorkerToReceiver: vi.fn(),
  updateCloudflareObservabilityConfig: vi.fn(),
}));

vi.mock("../commands/init/credentials.js", () => ({
  resolveApiKey: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import mocked dependencies
// ---------------------------------------------------------------------------

import {
  detectPlatformCli,
  checkPlatformAuth,
} from "../commands/deploy/platform.js";
import { updateAppEnv } from "../commands/deploy/env-writer.js";
import { waitForReceiver, fetchSetupToken } from "../commands/shared/health.js";
import { resolveApiKey } from "../commands/init/credentials.js";
import { connectCloudflareWorkerToReceiver } from "../commands/cloudflare-workers.js";
import { runDeploy } from "../commands/deploy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupHappyPathMocks(): void {
  vi.mocked(resolveApiKey).mockResolvedValue("sk-ant-test");
  vi.mocked(detectPlatformCli).mockReturnValue(true);
  vi.mocked(checkPlatformAuth).mockResolvedValue(true);
  mockProvider.deploy.mockResolvedValue({ url: "https://test.vercel.app" });
  mockProvider.setEnvVar.mockResolvedValue(undefined);
  mockProvider.cleanup.mockReturnValue(undefined);
  vi.mocked(waitForReceiver).mockResolvedValue(true);
  vi.mocked(fetchSetupToken).mockResolvedValue({
    status: "token",
    token: "test-token",
  });
  vi.mocked(updateAppEnv).mockReturnValue({
    added: ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS"],
    updated: [],
    envPath: "/path/.env",
  });
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

  it("sets ANTHROPIC_API_KEY on platform before deploying", async () => {
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

    // setEnvVar must be called before deploy
    const setEnvOrder = mockProvider.setEnvVar.mock.invocationCallOrder[0];
    const deployOrder = mockProvider.deploy.mock.invocationCallOrder[0];
    expect(setEnvOrder).toBeLessThan(deployOrder!);
  });

  it("passes projectName to the provider factory", async () => {
    setupHappyPathMocks();
    const { createProvider } = await import("../commands/deploy/provider.js");

    await runDeploy([], {
      yes: true,
      noInteractive: true,
      platform: "vercel",
      projectName: "3amoncall-receiver-dev",
    });

    expect(vi.mocked(createProvider)).toHaveBeenCalledWith("vercel", {
      projectName: "3amoncall-receiver-dev",
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

  it("happy path: first deploy with setup token", async () => {
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
    expect(waitForReceiver).toHaveBeenCalledWith(
      "https://test.vercel.app",
      60_000,
    );
    expect(fetchSetupToken).toHaveBeenCalledWith("https://test.vercel.app");

    const calls = vi.mocked(updateAppEnv).mock.calls;
    const writeCall = calls.find((c) => !c[0].dryRun);
    expect(writeCall).toBeDefined();
    expect(writeCall![0].receiverUrl).toBe("https://test.vercel.app");
    expect(writeCall![0].authToken).toBe("test-token");

    const stdout = stdoutChunks.join("");
    expect(stdout).toContain("Deploy complete");
    expect(stdout).toContain("https://test.vercel.app");
  });

  it("happy path: re-deploy with --auth-token", async () => {
    setupHappyPathMocks();
    vi.mocked(fetchSetupToken).mockResolvedValue({ status: "already-setup" });

    await runDeploy([], {
      yes: true,
      noInteractive: true,
      platform: "vercel",
      authToken: "provided-token",
    });

    expect(process.exit).not.toHaveBeenCalled();

    const calls = vi.mocked(updateAppEnv).mock.calls;
    const writeCall = calls.find((c) => !c[0].dryRun);
    expect(writeCall![0].authToken).toBe("provided-token");
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
      "test-token",
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
    expect(parsed.authToken).toBe("test-token");
    expect(parsed.envUpdated).toBe(true);

    expect(stderrText).toContain("Deploying Receiver");
  });
});
