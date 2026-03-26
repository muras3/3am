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
// Mock all sub-modules before importing the orchestrator
// ---------------------------------------------------------------------------

vi.mock("../commands/deploy/platform.js", () => ({
  detectPlatformCli: vi.fn(),
  checkPlatformAuth: vi.fn(),
  promptPlatformSelection: vi.fn(),
}));

vi.mock("../commands/deploy/executor.js", () => ({
  runPlatformDeploy: vi.fn(),
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

vi.mock("../commands/init/credentials.js", () => ({
  resolveApiKey: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import mocked dependencies
// ---------------------------------------------------------------------------

import {
  detectPlatformCli,
  checkPlatformAuth,
  promptPlatformSelection,
} from "../commands/deploy/platform.js";
import { runPlatformDeploy } from "../commands/deploy/executor.js";
import { updateAppEnv, promptAuthToken } from "../commands/deploy/env-writer.js";
import { waitForReceiver, fetchSetupToken } from "../commands/shared/health.js";
import { resolveApiKey } from "../commands/init/credentials.js";
import { runDeploy } from "../commands/deploy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupHappyPathMocks(): void {
  vi.mocked(resolveApiKey).mockResolvedValue("sk-ant-test");
  vi.mocked(detectPlatformCli).mockReturnValue(true);
  vi.mocked(checkPlatformAuth).mockResolvedValue(true);
  vi.mocked(runPlatformDeploy).mockResolvedValue({
    url: "https://test.vercel.app",
  });
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
    // --no-interactive without --platform triggers step 1 validation
    await runDeploy([], {
      yes: true,
      noInteractive: true,
      // platform deliberately omitted
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

  it("exits with error when deploy fails", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue("sk-ant-test");
    vi.mocked(detectPlatformCli).mockReturnValue(true);
    vi.mocked(checkPlatformAuth).mockResolvedValue(true);
    vi.mocked(runPlatformDeploy).mockRejectedValue(
      new Error("Deploy process exited with code 1"),
    );

    await runDeploy([], {
      yes: true,
      noInteractive: true,
      platform: "vercel",
    });

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(stderrChunks.join("")).toContain("deploy failed");
  });

  it("exits with error when --no-setup without --auth-token", async () => {
    await runDeploy([], {
      yes: true,
      noInteractive: true,
      platform: "vercel",
      noSetup: true,
      // authToken deliberately omitted
    });

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(stderrChunks.join("")).toContain("--no-setup requires --auth-token");
  });

  // -------------------------------------------------------------------------
  // Confirmation flow
  // -------------------------------------------------------------------------

  it("does not deploy when user declines deploy confirmation", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue("sk-ant-test");
    vi.mocked(detectPlatformCli).mockReturnValue(true);
    vi.mocked(checkPlatformAuth).mockResolvedValue(true);

    // User types "n" at deploy prompt
    setRlAnswers("n");

    await runDeploy([], {
      // no --yes: confirmation will be prompted
      platform: "vercel",
    });

    expect(runPlatformDeploy).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("skips .env write and prints manual instructions when user declines", async () => {
    setupHappyPathMocks();

    // 1st question = deploy confirm → "y"
    // 2nd question = .env confirm → "n"
    setRlAnswers("y", "n");

    await runDeploy([], {
      // no --yes so both confirmations are prompted
      platform: "vercel",
    });

    // updateAppEnv should have been called once (dryRun=true only)
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
    vi.mocked(waitForReceiver).mockResolvedValue(false); // timeout

    await runDeploy([], {
      yes: true,
      noInteractive: true,
      platform: "vercel",
    });

    // Should NOT exit(1)
    expect(process.exit).not.toHaveBeenCalled();

    // Warning output (goes to stdout in non-json mode)
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
    expect(runPlatformDeploy).toHaveBeenCalledWith("vercel");
    expect(waitForReceiver).toHaveBeenCalledWith(
      "https://test.vercel.app",
      60_000,
    );
    expect(fetchSetupToken).toHaveBeenCalledWith("https://test.vercel.app");

    // updateAppEnv called with dryRun=true then with actual write
    const calls = vi.mocked(updateAppEnv).mock.calls;
    const dryRunCall = calls.find((c) => c[0].dryRun === true);
    const writeCall = calls.find((c) => !c[0].dryRun);
    expect(dryRunCall).toBeDefined();
    expect(writeCall).toBeDefined();
    expect(writeCall![0].receiverUrl).toBe("https://test.vercel.app");
    expect(writeCall![0].authToken).toBe("test-token");

    const stdout = stdoutChunks.join("");
    expect(stdout).toContain("Deploy complete");
    expect(stdout).toContain("https://test.vercel.app");
  });

  it("happy path: re-deploy with --auth-token (setup returns already-setup)", async () => {
    setupHappyPathMocks();
    vi.mocked(fetchSetupToken).mockResolvedValue({ status: "already-setup" });

    await runDeploy([], {
      yes: true,
      noInteractive: true,
      platform: "vercel",
      authToken: "provided-token",
    });

    expect(process.exit).not.toHaveBeenCalled();

    // The provided token must be written to .env
    const calls = vi.mocked(updateAppEnv).mock.calls;
    const writeCall = calls.find((c) => !c[0].dryRun);
    expect(writeCall![0].authToken).toBe("provided-token");

    const stdout = stdoutChunks.join("");
    expect(stdout).toContain("Deploy complete");
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

    // stdout must be valid JSON
    const parsed = JSON.parse(stdoutText) as {
      status: string;
      receiverUrl: string;
      consoleUrl: string;
      authToken: string;
      envUpdated: boolean;
      envPath: string;
    };

    expect(parsed.status).toBe("deployed");
    expect(parsed.receiverUrl).toBe("https://test.vercel.app");
    expect(parsed.consoleUrl).toBe("https://test.vercel.app");
    expect(parsed.authToken).toBe("test-token");
    expect(parsed.envUpdated).toBe(true);
    expect(parsed.envPath).toBe("/path/.env");

    // Human text on stderr
    expect(stderrText).toContain("Deploying Receiver");
  });
});
