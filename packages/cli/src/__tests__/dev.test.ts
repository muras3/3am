import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";

// Mock child_process and fs before importing the module under test
vi.mock("node:child_process");
vi.mock("node:fs");

const mockExecSync = vi.mocked(childProcess.execSync);
const mockSpawnSync = vi.mocked(childProcess.spawnSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);

describe("runDev", () => {
  let originalExit: typeof process.exit;
  let originalEnv: NodeJS.ProcessEnv;
  let stderrOutput: string;
  let _stdoutOutput: string;

  beforeEach(() => {
    originalExit = process.exit;
    originalEnv = { ...process.env };
    stderrOutput = "";
    _stdoutOutput = "";
    process.exit = vi.fn() as never;
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrOutput += String(chunk);
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      _stdoutOutput += String(chunk);
      return true;
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.exit = originalExit;
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("exits with error when Docker is not installed", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("docker: command not found");
    });

    const { runDev } = await import("../commands/dev.js");
    runDev();

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(stderrOutput).toContain("Docker is a product prerequisite for local development");
    expect(stderrOutput).toContain("https://www.docker.com/products/docker-desktop/");
  });

  it("includes Docker prerequisite message in error", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const { runDev } = await import("../commands/dev.js");
    runDev();

    expect(stderrOutput).toMatch(/Docker is a product prerequisite/);
  });

  it("uses default port 3333 when no port option given", async () => {
    mockExecSync.mockReturnValue(Buffer.from("Docker version 24.0.0"));
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).endsWith("package.json")) return JSON.stringify({ version: "0.1.0" });
      return "";
    });
    mockSpawnSync.mockReturnValue({ status: 0, error: undefined } as ReturnType<typeof childProcess.spawnSync>);

    delete process.env["ANTHROPIC_API_KEY"];

    const { runDev } = await import("../commands/dev.js");
    runDev();

    expect(mockSpawnSync).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["-p", "3333:3000"]),
      expect.any(Object),
    );
  });

  it("uses custom port when --port option given", async () => {
    mockExecSync.mockReturnValue(Buffer.from("Docker version 24.0.0"));
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).endsWith("package.json")) return JSON.stringify({ version: "0.1.0" });
      return "";
    });
    mockSpawnSync.mockReturnValue({ status: 0, error: undefined } as ReturnType<typeof childProcess.spawnSync>);

    delete process.env["ANTHROPIC_API_KEY"];

    const { runDev } = await import("../commands/dev.js");
    runDev({ port: 8080 });

    expect(mockSpawnSync).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["-p", "8080:3000"]),
      expect.any(Object),
    );
  });

  it("passes ANTHROPIC_API_KEY from env to docker run", async () => {
    mockExecSync.mockReturnValue(Buffer.from("Docker version 24.0.0"));
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).endsWith("package.json")) return JSON.stringify({ version: "0.1.0" });
      return "";
    });
    mockSpawnSync.mockReturnValue({ status: 0, error: undefined } as ReturnType<typeof childProcess.spawnSync>);

    process.env["ANTHROPIC_API_KEY"] = "test-key-123";

    const { runDev } = await import("../commands/dev.js");
    runDev();

    expect(mockSpawnSync).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["-e", "ANTHROPIC_API_KEY=test-key-123"]),
      expect.any(Object),
    );
  });

  it("reads ANTHROPIC_API_KEY from .env file when not in env", async () => {
    mockExecSync.mockReturnValue(Buffer.from("Docker version 24.0.0"));
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((path) => {
      const p = String(path);
      if (p.endsWith("package.json")) return JSON.stringify({ version: "0.1.0" });
      if (p.endsWith(".env")) return "ANTHROPIC_API_KEY=dotenv-key-456\n";
      return "";
    });
    mockSpawnSync.mockReturnValue({ status: 0, error: undefined } as ReturnType<typeof childProcess.spawnSync>);

    delete process.env["ANTHROPIC_API_KEY"];

    const { runDev } = await import("../commands/dev.js");
    runDev();

    expect(mockSpawnSync).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["-e", "ANTHROPIC_API_KEY=dotenv-key-456"]),
      expect.any(Object),
    );
  });

  it("passes dev mode env vars to docker run", async () => {
    mockExecSync.mockReturnValue(Buffer.from("Docker version 24.0.0"));
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).endsWith("package.json")) return JSON.stringify({ version: "0.1.0" });
      return "";
    });
    mockSpawnSync.mockReturnValue({ status: 0, error: undefined } as ReturnType<typeof childProcess.spawnSync>);

    delete process.env["ANTHROPIC_API_KEY"];

    const { runDev } = await import("../commands/dev.js");
    runDev();

    const callArgs = mockSpawnSync.mock.calls[0]![1] as string[];
    expect(callArgs).toContain("ALLOW_INSECURE_DEV_MODE=true");
    expect(callArgs).toContain("DIAGNOSIS_GENERATION_THRESHOLD=0");
    expect(callArgs).toContain("DIAGNOSIS_MAX_WAIT_MS=0");
  });
});
