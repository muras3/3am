import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock child_process at module level so vitest hoisting works correctly
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import { detectFramework } from "../commands/init/detect-framework.js";
import { detectPackageManager } from "../commands/init/detect-package-manager.js";
import { getInstrumentationTemplate } from "../commands/init/templates.js";
import { updateEnvFile, runInit } from "../commands/init.js";

// ---------------------------------------------------------------------------
// detectFramework
// ---------------------------------------------------------------------------

describe("detectFramework()", () => {
  it("returns nextjs when next is in deps", () => {
    expect(detectFramework({ next: "14.0.0" })).toBe("nextjs");
  });

  it("returns express when express is in deps", () => {
    expect(detectFramework({ express: "4.18.0" })).toBe("express");
  });

  it("returns generic for unknown deps", () => {
    expect(detectFramework({ fastify: "4.0.0" })).toBe("generic");
  });

  it("prefers nextjs over express", () => {
    expect(detectFramework({ next: "14.0.0", express: "4.18.0" })).toBe("nextjs");
  });
});

// ---------------------------------------------------------------------------
// detectPackageManager
// ---------------------------------------------------------------------------

describe("detectPackageManager()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `pm-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns pnpm when pnpm-lock.yaml exists", () => {
    writeFileSync(join(tmpDir, "pnpm-lock.yaml"), "");
    expect(detectPackageManager(tmpDir)).toBe("pnpm");
  });

  it("returns yarn when yarn.lock exists", () => {
    writeFileSync(join(tmpDir, "yarn.lock"), "");
    expect(detectPackageManager(tmpDir)).toBe("yarn");
  });

  it("returns bun when bun.lockb exists", () => {
    writeFileSync(join(tmpDir, "bun.lockb"), "");
    expect(detectPackageManager(tmpDir)).toBe("bun");
  });

  it("returns npm as fallback", () => {
    expect(detectPackageManager(tmpDir)).toBe("npm");
  });
});

// ---------------------------------------------------------------------------
// templates
// ---------------------------------------------------------------------------

describe("getInstrumentationTemplate()", () => {
  it("nextjs template contains register() export", () => {
    const t = getInstrumentationTemplate("nextjs");
    expect(t).toContain("export function register()");
    expect(t).toContain("sdk.start()");
  });

  it("generic template does not have register() export", () => {
    const t = getInstrumentationTemplate("generic");
    expect(t).not.toContain("export function register()");
    expect(t).toContain("sdk.start()");
  });

  it("template includes OTLPTraceExporter", () => {
    expect(getInstrumentationTemplate("generic")).toContain("OTLPTraceExporter");
  });

  it("template includes PeriodicExportingMetricReader and OTLPMetricExporter", () => {
    const t = getInstrumentationTemplate("generic");
    expect(t).toContain("PeriodicExportingMetricReader");
    expect(t).toContain("OTLPMetricExporter");
  });

  it("template includes BatchLogRecordProcessor and OTLPLogExporter", () => {
    const t = getInstrumentationTemplate("generic");
    expect(t).toContain("BatchLogRecordProcessor");
    expect(t).toContain("OTLPLogExporter");
  });

  it("express template matches generic", () => {
    expect(getInstrumentationTemplate("express")).toBe(getInstrumentationTemplate("generic"));
  });
});

// ---------------------------------------------------------------------------
// updateEnvFile
// ---------------------------------------------------------------------------

describe("updateEnvFile()", () => {
  it("appends new key when not present", () => {
    const result = updateEnvFile("", { FOO: "bar" });
    expect(result).toContain("FOO=bar");
  });

  it("replaces existing key value", () => {
    const result = updateEnvFile("FOO=old\n", { FOO: "new" });
    expect(result).toContain("FOO=new");
    expect(result).not.toContain("FOO=old");
  });

  it("preserves other keys when replacing", () => {
    const result = updateEnvFile("BAR=keep\nFOO=old\n", { FOO: "new" });
    expect(result).toContain("BAR=keep");
    expect(result).toContain("FOO=new");
  });

  it("handles multiple updates", () => {
    const result = updateEnvFile("A=1\nB=2\n", { A: "10", B: "20" });
    expect(result).toContain("A=10");
    expect(result).toContain("B=20");
  });
});

// ---------------------------------------------------------------------------
// runInit integration
// ---------------------------------------------------------------------------

describe("runInit()", () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `init-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    origCwd = process.cwd();
    process.chdir(tmpDir);
    vi.mocked(execSync).mockReset();
    vi.mocked(execSync).mockImplementation(() => Buffer.from(""));
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("creates instrumentation.ts and updates .env", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "my-app", dependencies: { express: "4.18.0" } }),
    );

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runInit([]);

    stdoutSpy.mockRestore();

    expect(existsSync(join(tmpDir, "instrumentation.ts"))).toBe(true);
    const env = readFileSync(join(tmpDir, ".env"), "utf-8");
    expect(env).toContain("OTEL_SERVICE_NAME=my-app");
    expect(env).toContain("OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3333");
    expect(env).toContain("deployment.environment.name=development");
  });

  it("instrumentation.ts uses express/generic template (no register export)", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "my-app", dependencies: { express: "4.18.0" } }),
    );

    const stdoutChunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    await runInit([]);

    stdoutSpy.mockRestore();

    const template = readFileSync(join(tmpDir, "instrumentation.ts"), "utf-8");
    expect(template).not.toContain("export function register()");
    const combined = stdoutChunks.join("");
    expect(combined).toContain("--require");
  });

  it("skips instrumentation.ts if it already exists (idempotency)", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "my-app", dependencies: {} }),
    );
    const existingContent = "// existing instrumentation\n";
    writeFileSync(join(tmpDir, "instrumentation.ts"), existingContent);

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runInit([]);

    stdoutSpy.mockRestore();

    const content = readFileSync(join(tmpDir, "instrumentation.ts"), "utf-8");
    expect(content).toBe(existingContent);
  });

  it("does not duplicate env keys on second run (idempotency)", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "my-app", dependencies: {} }),
    );

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runInit([]);
    await runInit([]);

    stdoutSpy.mockRestore();

    const env = readFileSync(join(tmpDir, ".env"), "utf-8");
    const count = (env.match(/OTEL_SERVICE_NAME=/g) ?? []).length;
    expect(count).toBe(1);
  });

  it("restores package.json and exits on install failure", async () => {
    const pkg = { name: "my-app", dependencies: {} };
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify(pkg));

    vi.mocked(execSync).mockImplementation(() => { throw new Error("install failed"); });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runInit([]);

    expect(exitSpy).toHaveBeenCalledWith(1);

    const restoredPkg = JSON.parse(readFileSync(join(tmpDir, "package.json"), "utf-8")) as typeof pkg;
    expect(restoredPkg.name).toBe("my-app");

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it("exits with error when no package.json", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runInit([]);

    expect(exitSpy).toHaveBeenCalledWith(1);
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
