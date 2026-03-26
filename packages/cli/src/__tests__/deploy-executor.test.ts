import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// Mock node:child_process before importing executor
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { runPlatformDeploy } from "../commands/deploy/executor.js";

// ---------------------------------------------------------------------------
// Helper: create a mock ChildProcess
// ---------------------------------------------------------------------------

function createMockProcess(stdoutContent: string, exitCode: number) {
  const proc = new EventEmitter();
  const stdoutEmitter = new EventEmitter();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock ChildProcess shape
  (proc as any).stdout = stdoutEmitter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (proc as any).stderr = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (proc as any).stdin = null;

  // Emit stdout data, then close, then exit — all async
  setTimeout(() => {
    stdoutEmitter.emit("data", Buffer.from(stdoutContent));
    stdoutEmitter.emit("end");
    proc.emit("close", exitCode);
  }, 0);

  return proc;
}

const mockSpawn = vi.mocked(spawn);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runPlatformDeploy()", () => {
  let stdoutChunks: Array<string | Buffer>;

  beforeEach(() => {
    stdoutChunks = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutChunks.push(chunk as string | Buffer);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Vercel: succeeds, extracts URL
  // -------------------------------------------------------------------------
  it("extracts URL from Vercel stdout", async () => {
    const vercelOutput = [
      "Vercel CLI 32.0.0\n",
      "Deploying...\n",
      "Build completed.\n",
      "https://my-app-abc123.vercel.app\n",
      "Production deployment complete.\n",
    ].join("");

    mockSpawn.mockReturnValueOnce(
      createMockProcess(vercelOutput, 0) as ReturnType<typeof spawn>,
    );

    const result = await runPlatformDeploy("vercel");
    expect(result.url).toBe("https://my-app-abc123.vercel.app");
  });

  // -------------------------------------------------------------------------
  // 2. Cloudflare: succeeds, extracts URL
  // -------------------------------------------------------------------------
  it("extracts URL from Cloudflare stdout", async () => {
    const cfOutput = [
      "Building...\n",
      "Published my-worker (https://my-worker.my-domain.workers.dev)\n",
      "Done.\n",
    ].join("");

    mockSpawn.mockReturnValueOnce(
      createMockProcess(cfOutput, 0) as ReturnType<typeof spawn>,
    );

    const result = await runPlatformDeploy("cloudflare");
    expect(result.url).toBe("https://my-worker.my-domain.workers.dev");
  });

  // -------------------------------------------------------------------------
  // 3. Non-zero exit code → rejects with error containing exit code
  // -------------------------------------------------------------------------
  it("rejects with error containing exit code on non-zero exit", async () => {
    mockSpawn.mockReturnValueOnce(
      createMockProcess("Error: authentication required\n", 1) as ReturnType<
        typeof spawn
      >,
    );

    await expect(runPlatformDeploy("vercel")).rejects.toThrow(
      /exited with code 1/,
    );
  });

  // -------------------------------------------------------------------------
  // 4. No URL in stdout → rejects with descriptive error
  // -------------------------------------------------------------------------
  it("rejects with descriptive error when no URL is found", async () => {
    const noUrlOutput = "Deploying...\nDone.\n";

    mockSpawn.mockReturnValueOnce(
      createMockProcess(noUrlOutput, 0) as ReturnType<typeof spawn>,
    );

    await expect(runPlatformDeploy("vercel")).rejects.toThrow(
      /no deployment URL was found/,
    );
  });

  // -------------------------------------------------------------------------
  // 5. Vercel: spawns correct command
  // -------------------------------------------------------------------------
  it("spawns vercel with correct command and args", async () => {
    const vercelOutput = "https://test-app.vercel.app\n";

    mockSpawn.mockReturnValueOnce(
      createMockProcess(vercelOutput, 0) as ReturnType<typeof spawn>,
    );

    await runPlatformDeploy("vercel");

    expect(mockSpawn).toHaveBeenCalledWith("vercel", ["deploy", "--prod"], {
      stdio: ["inherit", "pipe", "inherit"],
    });
  });

  // -------------------------------------------------------------------------
  // 6. Cloudflare: spawns correct command
  // -------------------------------------------------------------------------
  it("spawns wrangler with correct command and args", async () => {
    const cfOutput =
      "Published my-worker (https://my-worker.example.workers.dev)\n";

    mockSpawn.mockReturnValueOnce(
      createMockProcess(cfOutput, 0) as ReturnType<typeof spawn>,
    );

    await runPlatformDeploy("cloudflare");

    expect(mockSpawn).toHaveBeenCalledWith("wrangler", ["deploy"], {
      stdio: ["inherit", "pipe", "inherit"],
    });
  });

  // -------------------------------------------------------------------------
  // 7. stdout is tee'd to process.stdout
  // -------------------------------------------------------------------------
  it("tees stdout chunks to process.stdout", async () => {
    const vercelOutput = "Build output\nhttps://tee-test.vercel.app\n";

    mockSpawn.mockReturnValueOnce(
      createMockProcess(vercelOutput, 0) as ReturnType<typeof spawn>,
    );

    await runPlatformDeploy("vercel");

    expect(process.stdout.write).toHaveBeenCalled();
    const written = stdoutChunks
      .map((c) => (Buffer.isBuffer(c) ? c.toString("utf8") : c))
      .join("");
    expect(written).toContain("Build output");
    expect(written).toContain("https://tee-test.vercel.app");
  });
});
