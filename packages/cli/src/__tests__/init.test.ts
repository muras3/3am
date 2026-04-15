import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock child_process at module level so vitest hoisting works correctly
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0 })),
}));

// Mock dev.ts to prevent actual Docker execution from init
vi.mock("../commands/dev.js", () => ({
  runDev: vi.fn(),
}));

// Readline mock — intercepts all createInterface calls, records each question
// asked, and answers immediately with "" so tests never hang on TTY prompts.
const _readlineQuestionsAsked: string[] = [];
vi.mock("node:readline", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const original = await importOriginal() as any;
  return {
    ...original,
    createInterface: vi.fn((opts) => {
      const rl = original.createInterface(opts);
      rl.question = (query: string, callback: (answer: string) => void) => {
        _readlineQuestionsAsked.push(query);
        rl.close();
        callback("");
      };
      return rl;
    }),
  };
});

import { execSync } from "node:child_process";
import { detectFramework } from "../commands/init/detect-framework.js";
import { detectRuntimeTarget, findWranglerConfigPath, isMonorepoRoot, findWorkspaceWranglerConfigs } from "../commands/init/detect-runtime.js";
import { updateCloudflareObservabilityConfig } from "../commands/cloudflare-workers.js";
import { detectLogger } from "../commands/init/detect-logger.js";
import { detectPackageManager } from "../commands/init/detect-package-manager.js";
import { getInstrumentationTemplate } from "../commands/init/templates.js";
import { updateEnvFile, runInit, isTypeScriptProject, isEsmProject, ensureGitignore, patchNextConfig, NEXTJS_SERVER_EXTERNAL_PACKAGES } from "../commands/init.js";
import { patchScripts } from "../commands/init/patch-scripts.js";
import { loadCredentials, saveCredentials } from "../commands/init/credentials.js";
import { runDev } from "../commands/dev.js";

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
// detectRuntimeTarget
// ---------------------------------------------------------------------------

describe("detectRuntimeTarget()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `runtime-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects cloudflare-workers when wrangler.jsonc exists", () => {
    writeFileSync(join(tmpDir, "wrangler.jsonc"), "{}\n");
    expect(detectRuntimeTarget(tmpDir)).toBe("cloudflare-workers");
    expect(findWranglerConfigPath(tmpDir)).toBe(join(tmpDir, "wrangler.jsonc"));
  });

  it("detects node-like when no wrangler config exists", () => {
    expect(detectRuntimeTarget(tmpDir)).toBe("node-like");
    expect(findWranglerConfigPath(tmpDir)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Monorepo detection (Bug 3)
// ---------------------------------------------------------------------------

describe("isMonorepoRoot()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `monorepo-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns true when pnpm-workspace.yaml exists", () => {
    writeFileSync(join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    expect(isMonorepoRoot(tmpDir)).toBe(true);
  });

  it("returns true when turbo.json exists", () => {
    writeFileSync(join(tmpDir, "turbo.json"), "{}");
    expect(isMonorepoRoot(tmpDir)).toBe(true);
  });

  it("returns false when no workspace markers exist", () => {
    expect(isMonorepoRoot(tmpDir)).toBe(false);
  });
});

describe("findWorkspaceWranglerConfigs()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ws-configs-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds wrangler.jsonc in apps/ subdirectory", () => {
    mkdirSync(join(tmpDir, "apps", "order-api"), { recursive: true });
    writeFileSync(join(tmpDir, "apps", "order-api", "wrangler.jsonc"), "{}");
    const found = findWorkspaceWranglerConfigs(tmpDir);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("order-api");
    expect(found[0]).toContain("wrangler.jsonc");
  });

  it("finds wrangler.toml in apps/ subdirectory", () => {
    mkdirSync(join(tmpDir, "apps", "my-worker"), { recursive: true });
    writeFileSync(join(tmpDir, "apps", "my-worker", "wrangler.toml"), 'name = "my-worker"');
    const found = findWorkspaceWranglerConfigs(tmpDir);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("wrangler.toml");
  });

  it("finds multiple workers across subdirectories", () => {
    mkdirSync(join(tmpDir, "apps", "worker-a"), { recursive: true });
    mkdirSync(join(tmpDir, "workers", "worker-b"), { recursive: true });
    writeFileSync(join(tmpDir, "apps", "worker-a", "wrangler.jsonc"), "{}");
    writeFileSync(join(tmpDir, "workers", "worker-b", "wrangler.toml"), 'name = "b"');
    const found = findWorkspaceWranglerConfigs(tmpDir);
    expect(found).toHaveLength(2);
  });

  it("returns empty array when no workers found", () => {
    mkdirSync(join(tmpDir, "apps", "web"), { recursive: true });
    writeFileSync(join(tmpDir, "apps", "web", "package.json"), "{}");
    const found = findWorkspaceWranglerConfigs(tmpDir);
    expect(found).toHaveLength(0);
  });
});

describe("runInit() — monorepo root guard (Bug 3)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `init-monorepo-test-${Date.now()}`);
    mkdirSync(join(tmpDir, "apps", "order-api"), { recursive: true });
    // Workspace root markers
    writeFileSync(join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    writeFileSync(join(tmpDir, "turbo.json"), "{}");
    // Worker in subdirectory
    writeFileSync(join(tmpDir, "apps", "order-api", "wrangler.jsonc"), JSON.stringify({ name: "order-api" }));
    // Root package.json (no wrangler config at root)
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "my-monorepo" }));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exits with error in --no-interactive mode when workers exist in subdirectories", async () => {
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code) => { throw new Error("process.exit"); });

    try {
      await expect(
        runInit([], { noInteractive: true }),
      ).rejects.toThrow("process.exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
      const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(stderrOutput).toContain("monorepo root");
      expect(stderrOutput).toContain("order-api");
    } finally {
      process.chdir(originalCwd);
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// detectLogger
// ---------------------------------------------------------------------------

describe("detectLogger()", () => {
  it("detects pino", () => {
    const result = detectLogger({ pino: "8.0.0", express: "4.18.0" });
    expect(result.name).toBe("pino");
    expect(result.instrumentationPackage).toBe("@opentelemetry/instrumentation-pino");
  });

  it("detects winston", () => {
    const result = detectLogger({ winston: "3.10.0" });
    expect(result.name).toBe("winston");
    expect(result.instrumentationPackage).toBe("@opentelemetry/instrumentation-winston");
  });

  it("detects bunyan", () => {
    const result = detectLogger({ bunyan: "1.8.0" });
    expect(result.name).toBe("bunyan");
    expect(result.instrumentationPackage).toBe("@opentelemetry/instrumentation-bunyan");
  });

  it("returns null when no logger found", () => {
    const result = detectLogger({ express: "4.18.0" });
    expect(result.name).toBeNull();
    expect(result.instrumentationPackage).toBeNull();
  });

  it("prefers pino when multiple loggers present", () => {
    const result = detectLogger({ pino: "8.0.0", winston: "3.10.0" });
    expect(result.name).toBe("pino");
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

  it("returns pnpm when pnpm-workspace.yaml exists", () => {
    writeFileSync(join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    expect(detectPackageManager(tmpDir)).toBe("pnpm");
  });

  it("returns pnpm when workspace marker exists in an ancestor directory", () => {
    writeFileSync(join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    const nestedDir = join(tmpDir, "apps", "order-api");
    mkdirSync(nestedDir, { recursive: true });
    expect(detectPackageManager(nestedDir)).toBe("pnpm");
  });

  it("returns yarn when yarn.lock exists", () => {
    writeFileSync(join(tmpDir, "yarn.lock"), "");
    expect(detectPackageManager(tmpDir)).toBe("yarn");
  });

  it("returns yarn when yarn.lock exists in an ancestor directory", () => {
    writeFileSync(join(tmpDir, "yarn.lock"), "");
    const nestedDir = join(tmpDir, "packages", "api");
    mkdirSync(nestedDir, { recursive: true });
    expect(detectPackageManager(nestedDir)).toBe("yarn");
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

  it("template includes BatchLogRecordProcessor from sdk-logs and OTLPLogExporter", () => {
    const t = getInstrumentationTemplate("generic");
    expect(t).toContain("BatchLogRecordProcessor");
    expect(t).toContain("OTLPLogExporter");
    expect(t).toContain('from "@opentelemetry/sdk-logs"');
    expect(t).not.toContain('BatchLogRecordProcessor } from "@opentelemetry/sdk-node"');
  });

  it("express template matches generic", () => {
    expect(getInstrumentationTemplate("express")).toBe(getInstrumentationTemplate("generic"));
  });
});

// ---------------------------------------------------------------------------
// updateEnvFile (idempotent)
// ---------------------------------------------------------------------------

describe("updateEnvFile()", () => {
  it("appends new key when not present", () => {
    const result = updateEnvFile("", { FOO: "bar" });
    expect(result).toContain("FOO=bar");
  });

  it("preserves existing non-empty value (does NOT overwrite)", () => {
    const result = updateEnvFile("FOO=old\n", { FOO: "new" });
    expect(result).toContain("FOO=old");
    expect(result).not.toContain("FOO=new");
  });

  it("overwrites empty value (KEY=)", () => {
    const result = updateEnvFile("FOO=\n", { FOO: "new" });
    expect(result).toContain("FOO=new");
  });

  it("preserves other keys", () => {
    const result = updateEnvFile("BAR=keep\n", { FOO: "new" });
    expect(result).toContain("BAR=keep");
    expect(result).toContain("FOO=new");
  });

  it("handles multiple updates", () => {
    const result = updateEnvFile("A=1\n", { A: "10", B: "20" });
    // A has non-empty value → preserved
    expect(result).toContain("A=1");
    // B is new → appended
    expect(result).toContain("B=20");
  });

  it("does not duplicate keys on repeated calls", () => {
    let env = updateEnvFile("", { FOO: "bar" });
    env = updateEnvFile(env, { FOO: "baz" });
    const count = (env.match(/FOO=/g) ?? []).length;
    expect(count).toBe(1);
    // First value preserved
    expect(env).toContain("FOO=bar");
  });

  // Migrated from init-upgrade.test.ts — still valid for updateEnvFile
  it("appends OTLP headers if not present in existing .env", () => {
    const envWithoutHeaders = "OTEL_SERVICE_NAME=my-app\nOTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3333\n";
    const result = updateEnvFile(envWithoutHeaders, {
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer tok",
    });
    expect(result).toContain("OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer tok");
  });

  it("preserves existing endpoint when calling with new value", () => {
    const env = "OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3333\n";
    const result = updateEnvFile(env, {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://prod.example.com",
    });
    // Existing non-empty value preserved
    expect(result).toContain("OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3333");
    expect(result).not.toContain("prod.example.com");
  });

  it("adds NOTIFICATION_WEBHOOK_URL when not present", () => {
    const result = updateEnvFile("EXISTING_KEY=value\n", {
      NOTIFICATION_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/x",
    });
    expect(result).toContain("NOTIFICATION_WEBHOOK_URL=https://hooks.slack.com/services/T/B/x");
  });

  it("preserves existing non-empty NOTIFICATION_WEBHOOK_URL", () => {
    const existing = "NOTIFICATION_WEBHOOK_URL=https://hooks.slack.com/services/old\n";
    const result = updateEnvFile(existing, {
      NOTIFICATION_WEBHOOK_URL: "https://hooks.slack.com/services/new",
    });
    expect(result).toContain("https://hooks.slack.com/services/old");
    expect(result).not.toContain("https://hooks.slack.com/services/new");
  });
});

// ---------------------------------------------------------------------------
// Cloudflare Workers config patching
// ---------------------------------------------------------------------------

describe("updateCloudflareObservabilityConfig()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `wrangler-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("patches wrangler.toml with observability settings", () => {
    const path = join(tmpDir, "wrangler.toml");
    writeFileSync(path, 'name = "worker"\nmain = "src/index.ts"\n');

    expect(updateCloudflareObservabilityConfig(path)).toBe(true);

    const content = readFileSync(path, "utf-8");
    expect(content).toContain("[observability]");
    expect(content).toContain("enabled = true");
    expect(content).toContain("[observability.logs]");
    expect(content).toContain("invocation_logs = true");
    expect(content).toContain("[observability.traces]");
    expect(content).toContain("head_sampling_rate = 1.0");
  });

  it("patches wrangler.jsonc with observability settings", () => {
    const path = join(tmpDir, "wrangler.jsonc");
    writeFileSync(path, '{\n  "name": "worker"\n}\n');

    expect(updateCloudflareObservabilityConfig(path)).toBe(true);

    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      observability: {
        enabled: boolean;
        logs: { enabled: boolean; invocation_logs: boolean };
        traces: { enabled: boolean; head_sampling_rate: number };
      };
    };

    expect(parsed.observability.enabled).toBe(true);
    expect(parsed.observability.logs.invocation_logs).toBe(true);
    expect(parsed.observability.traces.enabled).toBe(true);
    expect(parsed.observability.traces.head_sampling_rate).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// patchScripts
// ---------------------------------------------------------------------------

describe("patchScripts()", () => {
  it("patches node command with --import for ESM", () => {
    const result = patchScripts(
      { start: "node app.js" },
      "instrumentation.ts",
      false,
      true,
    );
    expect(result.patched["start"]).toBe("node --import ./instrumentation.ts app.js");
  });

  it("patches node command with --require for CJS", () => {
    const result = patchScripts(
      { start: "node app.js" },
      "instrumentation.js",
      false,
      false,
    );
    expect(result.patched["start"]).toBe("node --require ./instrumentation.js app.js");
  });

  it("replaces ts-node with node --import", () => {
    const result = patchScripts(
      { start: "ts-node app.ts" },
      "instrumentation.ts",
      false,
      true,
    );
    expect(result.patched["start"]).toBe("node --import ./instrumentation.ts app.ts");
  });

  it("patches nodemon with --require for CJS", () => {
    const result = patchScripts(
      { dev: "nodemon app.js" },
      "instrumentation.js",
      false,
      false,
    );
    expect(result.patched["dev"]).toBe("nodemon --require ./instrumentation.js app.js");
  });

  it("patches nodemon with --import for ESM", () => {
    const result = patchScripts(
      { dev: "nodemon app.js" },
      "instrumentation.ts",
      false,
      true,
    );
    expect(result.patched["dev"]).toBe("nodemon --import ./instrumentation.ts app.js");
  });

  it("skips Next.js scripts", () => {
    const result = patchScripts(
      { dev: "next dev", start: "next start" },
      "instrumentation.ts",
      true,
      true,
    );
    expect(result.patched).toEqual({});
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0]!.reason).toContain("Next.js");
  });

  it("skips already-patched scripts", () => {
    const result = patchScripts(
      { start: "node --import ./instrumentation.ts app.js" },
      "instrumentation.ts",
      false,
      true,
    );
    expect(result.patched).toEqual({});
    expect(result.skipped[0]!.reason).toContain("already includes");
  });

  it("skips unrecognized commands", () => {
    const result = patchScripts(
      { start: "bun run app.ts" },
      "instrumentation.ts",
      false,
      true,
    );
    expect(result.patched).toEqual({});
    expect(result.skipped[0]!.reason).toContain("unrecognized");
  });

  it("returns empty when no scripts", () => {
    const result = patchScripts(undefined, "instrumentation.ts", false, true);
    expect(result.patched).toEqual({});
    expect(result.skipped).toEqual([]);
  });

  it("patches multiple script targets", () => {
    const result = patchScripts(
      { start: "node server.js", dev: "nodemon server.js" },
      "instrumentation.js",
      false,
      false,
    );
    expect(result.patched["start"]).toBe("node --require ./instrumentation.js server.js");
    expect(result.patched["dev"]).toBe("nodemon --require ./instrumentation.js server.js");
  });
});

// ---------------------------------------------------------------------------
// credentials
// ---------------------------------------------------------------------------

describe("credentials", () => {
  let tmpDir: string;
  let origHome: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `creds-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    origHome = process.env["HOME"]!;
    process.env["HOME"] = tmpDir;
  });

  afterEach(() => {
    process.env["HOME"] = origHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty when no credentials file exists", () => {
    expect(loadCredentials()).toEqual({});
  });

  it("saves and loads credentials", () => {
    saveCredentials({ anthropicApiKey: "sk-test-123" });
    const loaded = loadCredentials();
    expect(loaded.anthropicApiKey).toBe("sk-test-123");
  });

  it("creates credentials file with 0600 permissions", () => {
    saveCredentials({ anthropicApiKey: "sk-test" });
    const stat = statSync(join(tmpDir, ".config", "3am", "credentials"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("saves and loads locale in credentials", () => {
    saveCredentials({ anthropicApiKey: "sk-test-123", locale: "ja" });
    const loaded = loadCredentials();
    expect(loaded.anthropicApiKey).toBe("sk-test-123");
    expect(loaded.locale).toBe("ja");
  });

  it("preserves locale when updating api key", () => {
    saveCredentials({ locale: "ja" });
    const existing = loadCredentials();
    saveCredentials({ ...existing, anthropicApiKey: "sk-new" });
    const loaded = loadCredentials();
    expect(loaded.locale).toBe("ja");
    expect(loaded.anthropicApiKey).toBe("sk-new");
  });
});

// ---------------------------------------------------------------------------
// ensureGitignore
// ---------------------------------------------------------------------------

describe("ensureGitignore()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `gitignore-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates .gitignore with .env if it doesn't exist", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    ensureGitignore(tmpDir);
    stdoutSpy.mockRestore();

    const content = readFileSync(join(tmpDir, ".gitignore"), "utf-8");
    expect(content).toContain(".env");
  });

  it("adds .env to existing .gitignore", () => {
    writeFileSync(join(tmpDir, ".gitignore"), "node_modules\n");
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    ensureGitignore(tmpDir);
    stdoutSpy.mockRestore();

    const content = readFileSync(join(tmpDir, ".gitignore"), "utf-8");
    expect(content).toContain("node_modules");
    expect(content).toContain(".env");
  });

  it("does not duplicate .env if already present", () => {
    writeFileSync(join(tmpDir, ".gitignore"), "node_modules\n.env\n");
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    ensureGitignore(tmpDir);
    stdoutSpy.mockRestore();

    const content = readFileSync(join(tmpDir, ".gitignore"), "utf-8");
    const count = (content.match(/\.env/g) ?? []).length;
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// isTypeScriptProject
// ---------------------------------------------------------------------------

describe("isTypeScriptProject()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ts-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns true when typescript is in deps", () => {
    expect(isTypeScriptProject(tmpDir, { typescript: "5.0.0" })).toBe(true);
  });

  it("returns true when tsconfig.json exists", () => {
    writeFileSync(join(tmpDir, "tsconfig.json"), "{}");
    expect(isTypeScriptProject(tmpDir, {})).toBe(true);
  });

  it("returns false for plain JS project", () => {
    expect(isTypeScriptProject(tmpDir, { express: "4.18.0" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isEsmProject
// ---------------------------------------------------------------------------

describe("isEsmProject()", () => {
  it("returns true when type is module", () => {
    expect(isEsmProject({ type: "module" })).toBe(true);
  });

  it("returns false when type is commonjs", () => {
    expect(isEsmProject({ type: "commonjs" })).toBe(false);
  });

  it("returns false when type is absent", () => {
    expect(isEsmProject({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runInit integration
// ---------------------------------------------------------------------------

describe("runInit()", () => {
  let tmpDir: string;
  let origCwd: string;
  let origHome: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `init-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    origCwd = process.cwd();
    origHome = process.env["HOME"]!;
    process.env["HOME"] = tmpDir;
    process.chdir(tmpDir);
    vi.mocked(execSync).mockReset();
    // Mock execSync: return success for install, docker check returns success
    vi.mocked(execSync).mockImplementation((cmd) => {
      const cmdStr = String(cmd);
      if (cmdStr === "docker --version") return Buffer.from("Docker version 24.0.0");
      return Buffer.from("");
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    delete process.env["ANTHROPIC_API_KEY"];
  });

  afterEach(() => {
    process.chdir(origCwd);
    process.env["HOME"] = origHome;
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("creates instrumentation.ts for TypeScript project and updates .env", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "my-app", dependencies: { express: "4.18.0", typescript: "5.0.0" } }),
    );

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runInit([], { noInteractive: true });
    stdoutSpy.mockRestore();

    expect(existsSync(join(tmpDir, "instrumentation.ts"))).toBe(true);
    expect(existsSync(join(tmpDir, "instrumentation.js"))).toBe(false);
    const env = readFileSync(join(tmpDir, ".env"), "utf-8");
    expect(env).toContain("OTEL_SERVICE_NAME=my-app");
    expect(env).toContain("OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3333");
    expect(env).toContain("deployment.environment.name=development");
  });

  it("creates instrumentation.js for JavaScript project", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "my-app", dependencies: { express: "4.18.0" } }),
    );

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runInit([], { noInteractive: true });
    stdoutSpy.mockRestore();

    expect(existsSync(join(tmpDir, "instrumentation.js"))).toBe(true);
    expect(existsSync(join(tmpDir, "instrumentation.ts"))).toBe(false);
  });

  it("patches node scripts automatically", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        name: "my-app",
        scripts: { start: "node app.js" },
        dependencies: { express: "4.18.0" },
      }),
    );

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runInit([], { noInteractive: true });
    stdoutSpy.mockRestore();

    const pkg = JSON.parse(readFileSync(join(tmpDir, "package.json"), "utf-8"));
    expect(pkg.scripts.start).toBe("node --require ./instrumentation.js app.js");
  });

  it("does not patch Next.js scripts", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        name: "my-app",
        scripts: { dev: "next dev", start: "next start" },
        dependencies: { next: "14.0.0", typescript: "5.0.0" },
      }),
    );

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runInit([], { noInteractive: true });
    stdoutSpy.mockRestore();

    const pkg = JSON.parse(readFileSync(join(tmpDir, "package.json"), "utf-8"));
    expect(pkg.scripts.dev).toBe("next dev");
    expect(pkg.scripts.start).toBe("next start");
  });

  it("creates .gitignore with .env entry", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "my-app", dependencies: {} }),
    );

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runInit([], { noInteractive: true });
    stdoutSpy.mockRestore();

    expect(existsSync(join(tmpDir, ".gitignore"))).toBe(true);
    const gitignore = readFileSync(join(tmpDir, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".env");
  });

  it("saves API key from --api-key flag to credentials", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "my-app", dependencies: {} }),
    );

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runInit([], { apiKey: "sk-test-key-123" });
    stdoutSpy.mockRestore();

    const creds = loadCredentials();
    expect(creds.anthropicApiKey).toBe("sk-test-key-123");
  });

  it("saves locale from --lang in non-interactive mode", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "my-app", dependencies: {} }),
    );

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runInit([], { lang: "ja", noInteractive: true });
    stdoutSpy.mockRestore();

    const creds = loadCredentials();
    expect(creds.locale).toBe("ja");
  });

  it("warns when no API key in non-interactive mode", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "my-app", dependencies: {} }),
    );

    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runInit([], { noInteractive: true });

    stdoutSpy.mockRestore();

    const combined = stderrChunks.join("");
    expect(combined).toContain("ANTHROPIC_API_KEY not configured");
    expect(combined).toContain("npx 3am init --api-key");
  });

  it("preserves existing .env values on second run (idempotency)", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "my-app", dependencies: {} }),
    );

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runInit([], { noInteractive: true });

    // Manually change a value to simulate user customization
    const envPath = join(tmpDir, ".env");
    const envContent = readFileSync(envPath, "utf-8");
    writeFileSync(envPath, envContent.replace("http://localhost:3333", "http://custom:4444"));

    await runInit([], { noInteractive: true });

    stdoutSpy.mockRestore();

    const finalEnv = readFileSync(envPath, "utf-8");
    // Custom value should be preserved
    expect(finalEnv).toContain("OTEL_EXPORTER_OTLP_ENDPOINT=http://custom:4444");
    expect(finalEnv).not.toContain("localhost:3333");
    // Only one occurrence of each key
    expect((finalEnv.match(/OTEL_SERVICE_NAME=/g) ?? []).length).toBe(1);
  });

  it("skips instrumentation file if it already exists (idempotency)", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "my-app", dependencies: {} }),
    );
    const existingContent = "// existing instrumentation\n";
    writeFileSync(join(tmpDir, "instrumentation.js"), existingContent);

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runInit([], { noInteractive: true });
    stdoutSpy.mockRestore();

    const content = readFileSync(join(tmpDir, "instrumentation.js"), "utf-8");
    expect(content).toBe(existingContent);
  });

  it("restores package.json and exits on install failure", async () => {
    const pkg = { name: "my-app", dependencies: {} };
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify(pkg));

    vi.mocked(execSync).mockImplementation((cmd) => {
      const cmdStr = String(cmd);
      if (cmdStr === "docker --version") return Buffer.from("Docker version 24.0.0");
      throw new Error("install failed");
    });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runInit([], { noInteractive: true });

    expect(exitSpy).toHaveBeenCalledWith(1);

    const restoredPkg = JSON.parse(readFileSync(join(tmpDir, "package.json"), "utf-8"));
    expect(restoredPkg.name).toBe("my-app");

    expect(existsSync(join(tmpDir, "instrumentation.js"))).toBe(false);
    expect(existsSync(join(tmpDir, "instrumentation.ts"))).toBe(false);
    expect(existsSync(join(tmpDir, ".env"))).toBe(false);

    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it("includes logger instrumentation package when pino is in deps", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "my-app", dependencies: { express: "4.18.0", pino: "8.0.0" } }),
    );

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runInit([], { noInteractive: true });
    stdoutSpy.mockRestore();

    const installCall = vi.mocked(execSync).mock.calls.find(
      (c) => String(c[0]).includes("install") || String(c[0]).includes("add"),
    );
    expect(String(installCall?.[0])).toContain("@opentelemetry/instrumentation-pino");
  });

  it("shows self-check with logger detected", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "my-app", dependencies: { express: "4.18.0", winston: "3.10.0" } }),
    );

    const stdoutChunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    await runInit([], { noInteractive: true });
    stdoutSpy.mockRestore();

    const combined = stdoutChunks.join("");
    expect(combined).toContain("Traces");
    expect(combined).toContain("Metrics");
    expect(combined).toContain("winston detected, bridge installed");
  });

  it("shows warning when no logger detected", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "my-app", dependencies: { express: "4.18.0" } }),
    );

    const stdoutChunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    await runInit([], { noInteractive: true });
    stdoutSpy.mockRestore();

    const combined = stdoutChunks.join("");
    expect(combined).toContain("no structured logger detected");
  });

  it("does not start the local receiver automatically and prints next steps", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "my-app", dependencies: { express: "4.18.0" } }),
    );

    const stdoutChunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    await runInit([], { noInteractive: true });
    stdoutSpy.mockRestore();

    expect(vi.mocked(runDev)).not.toHaveBeenCalled();
    const combined = stdoutChunks.join("");
    expect(combined).toContain("npx 3am local");
    expect(combined).toContain("npx 3am local demo");
  });

  it("exits with error when no package.json", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

    await runInit([], { noInteractive: true });

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("does not ask for webhook URL when --no-interactive is set", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "my-app", dependencies: { express: "4.18.0" } }),
    );

    const stdoutChunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    await runInit([], { noInteractive: true });
    stdoutSpy.mockRestore();

    const combined = stdoutChunks.join("");
    expect(combined).not.toContain("webhook URL");
    expect(combined).not.toContain("Slack/Discord");
    // NOTIFICATION_WEBHOOK_URL should NOT be written to .env
    const envContent = existsSync(join(tmpDir, ".env"))
      ? readFileSync(join(tmpDir, ".env"), "utf-8")
      : "";
    expect(envContent).not.toContain("NOTIFICATION_WEBHOOK_URL");
  });

  it("configures Cloudflare Workers projects without Node SDK injection", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        name: "my-worker",
        scripts: { dev: "wrangler dev" },
        dependencies: { hono: "4.0.0" },
      }),
    );
    writeFileSync(join(tmpDir, "wrangler.jsonc"), '{\n  "name": "my-worker"\n}\n');

    const stdoutChunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    await runInit([], { noInteractive: true });
    stdoutSpy.mockRestore();

    expect(vi.mocked(execSync)).not.toHaveBeenCalled();
    expect(existsSync(join(tmpDir, "instrumentation.js"))).toBe(false);
    expect(existsSync(join(tmpDir, "instrumentation.ts"))).toBe(false);
    expect(existsSync(join(tmpDir, ".env"))).toBe(false);

    const wrangler = JSON.parse(readFileSync(join(tmpDir, "wrangler.jsonc"), "utf-8")) as {
      observability: {
        enabled: boolean;
        logs: { enabled: boolean; invocation_logs: boolean };
        traces: { enabled: boolean; head_sampling_rate: number };
      };
    };
    expect(wrangler.observability.enabled).toBe(true);
    expect(wrangler.observability.logs.enabled).toBe(true);
    expect(wrangler.observability.logs.invocation_logs).toBe(true);
    expect(wrangler.observability.traces.enabled).toBe(true);
    expect(wrangler.observability.traces.head_sampling_rate).toBe(1);

    const combined = stdoutChunks.join("");
    expect(combined).toContain("Cloudflare Workers");
    expect(combined).toContain("Workers Observability");
    expect(combined).toContain("Cloudflare OTLP destination");
    expect(combined).toContain("Metrics");
    expect(combined).toContain("not supported");
  });

  it("sends a Slack test notification and reports success when fetch succeeds", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "my-app", dependencies: { express: "4.18.0" } }),
    );

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", mockFetch);

    const stdoutChunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    await runInit([], { noInteractive: true, webhookUrl: "https://hooks.slack.com/services/T/B/x" });
    stdoutSpy.mockRestore();
    vi.unstubAllGlobals();

    const combined = stdoutChunks.join("");
    expect(combined).toContain("hooks.slack.com");

    // Test notification should have been sent with Slack payload format
    expect(mockFetch).toHaveBeenCalledWith(
      "https://hooks.slack.com/services/T/B/x",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "✓ 3am connected! Incident notifications will appear here." }),
      }),
    );

    // Success message should appear
    expect(combined).toContain("Test message sent ✓");
  });

  it("sends a Discord test notification with correct payload", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "my-app", dependencies: { express: "4.18.0" } }),
    );

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", mockFetch);

    const stdoutChunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    await runInit([], { noInteractive: true, webhookUrl: "https://discord.com/api/webhooks/123/abc" });
    stdoutSpy.mockRestore();
    vi.unstubAllGlobals();

    expect(mockFetch).toHaveBeenCalledWith(
      "https://discord.com/api/webhooks/123/abc",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ content: "✓ 3am connected! Incident notifications will appear here." }),
      }),
    );

    const combined = stdoutChunks.join("");
    expect(combined).toContain("Test message sent ✓");
  });

  it("reports failure non-fatally when test notification fetch returns error status", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "my-app", dependencies: { express: "4.18.0" } }),
    );

    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 400 });
    vi.stubGlobal("fetch", mockFetch);

    const stdoutChunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    await runInit([], { noInteractive: true, webhookUrl: "https://hooks.slack.com/services/T/B/bad" });
    stdoutSpy.mockRestore();
    vi.unstubAllGlobals();

    const combined = stdoutChunks.join("");
    // Should show failure message but not throw
    expect(combined).toContain("Test message failed");
    expect(combined).toContain("HTTP 400");
    // Init should still complete
    expect(combined).toContain("init complete");
  });

  it("reports failure non-fatally when test notification fetch throws (network error)", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "my-app", dependencies: { express: "4.18.0" } }),
    );

    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", mockFetch);

    const stdoutChunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    await runInit([], { noInteractive: true, webhookUrl: "https://hooks.slack.com/services/T/B/net" });
    stdoutSpy.mockRestore();
    vi.unstubAllGlobals();

    const combined = stdoutChunks.join("");
    expect(combined).toContain("Test message failed");
    expect(combined).toContain("ECONNREFUSED");
    // Init should still complete
    expect(combined).toContain("init complete");
  });

  it("writes webhook URL to .env even when test notification fails", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "my-app", dependencies: { express: "4.18.0" } }),
    );

    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    vi.stubGlobal("fetch", mockFetch);

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runInit([], { noInteractive: true, webhookUrl: "https://hooks.slack.com/services/T/B/z" });
    stdoutSpy.mockRestore();
    vi.unstubAllGlobals();

    const envContent = readFileSync(join(tmpDir, ".env"), "utf-8");
    expect(envContent).toContain("NOTIFICATION_WEBHOOK_URL=https://hooks.slack.com/services/T/B/z");
  });

  it("patches next.config with serverExternalPackages for plain Next.js (no Vercel)", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        name: "my-nextjs-app",
        dependencies: { next: "14.0.0", typescript: "5.0.0" },
      }),
    );
    writeFileSync(
      join(tmpDir, "next.config.ts"),
      'import type { NextConfig } from "next";\nconst nextConfig: NextConfig = {};\nexport default nextConfig;\n',
    );

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runInit([], { noInteractive: true });
    stdoutSpy.mockRestore();

    const content = readFileSync(join(tmpDir, "next.config.ts"), "utf-8");
    expect(content).toContain("serverExternalPackages");
    expect(content).toContain("@opentelemetry/auto-instrumentations-node");
    expect(content).toContain("require-in-the-middle");
    // Vercel-specific packages (pino, winston, bunyan) should NOT be present for non-Vercel
    expect(content).not.toContain('"pino"');
    expect(content).not.toContain('"winston"');
  });

  it("does not double-patch next.config on second runInit (idempotency)", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        name: "my-nextjs-app",
        dependencies: { next: "14.0.0" },
      }),
    );
    writeFileSync(
      join(tmpDir, "next.config.js"),
      'const nextConfig = {};\nmodule.exports = nextConfig;\n',
    );

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runInit([], { noInteractive: true });
    await runInit([], { noInteractive: true });
    stdoutSpy.mockRestore();

    const content = readFileSync(join(tmpDir, "next.config.js"), "utf-8");
    const count = (content.match(/serverExternalPackages/g) ?? []).length;
    expect(count).toBe(1);
  });

  it("warns when Next.js project has no next.config file", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        name: "my-nextjs-app",
        dependencies: { next: "14.0.0" },
      }),
    );
    // Deliberately do NOT create next.config.*

    const stdoutChunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    await runInit([], { noInteractive: true });
    stdoutSpy.mockRestore();

    const combined = stdoutChunks.join("");
    expect(combined).toContain("no next.config found");
    expect(combined).toContain("serverExternalPackages");
  });

  // -------------------------------------------------------------------------
  // Flag precedence over interactive prompts (#fix/init-mode-flag-override)
  // -------------------------------------------------------------------------

  it("saves mode=manual when --mode manual is explicitly passed (non-interactive)", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "my-app", dependencies: {} }),
    );

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runInit([], { mode: "manual", noInteractive: true });
    stdoutSpy.mockRestore();

    const creds = loadCredentials();
    expect(creds.llmMode).toBe("manual");
  });

  it("does not prompt for mode when --mode is explicitly provided even in TTY", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "my-app", dependencies: {} }),
    );

    // Simulate a TTY environment
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    // Clear the shared question tracker before this test
    _readlineQuestionsAsked.length = 0;

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runInit([], { mode: "manual" });
    stdoutSpy.mockRestore();

    // Restore isTTY
    Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, configurable: true });

    // The mode prompt should NOT have been shown — flag takes precedence
    const modePromptsShown = _readlineQuestionsAsked.filter((q) => q.includes("automatic/manual"));
    expect(modePromptsShown).toHaveLength(0);

    const creds = loadCredentials();
    expect(creds.llmMode).toBe("manual");
  });

  it("does not prompt for provider when --provider is explicitly provided even in TTY", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "my-app", dependencies: {} }),
    );

    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    _readlineQuestionsAsked.length = 0;

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runInit([], { provider: "anthropic" });
    stdoutSpy.mockRestore();

    Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, configurable: true });

    // The provider prompt should NOT have been shown — flag takes precedence
    const providerPromptsShown = _readlineQuestionsAsked.filter((q) => q.includes("LLM provider"));
    expect(providerPromptsShown).toHaveLength(0);

    const creds = loadCredentials();
    expect(creds.llmProvider).toBe("anthropic");
  });
});

// ---------------------------------------------------------------------------
// patchNextConfig (unit)
// ---------------------------------------------------------------------------

describe("patchNextConfig()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `next-config-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("injects serverExternalPackages into next.config.ts (NextConfig assignment)", () => {
    writeFileSync(
      join(tmpDir, "next.config.ts"),
      'import type { NextConfig } from "next";\nconst nextConfig: NextConfig = {};\nexport default nextConfig;\n',
    );
    const patched = patchNextConfig(tmpDir, NEXTJS_SERVER_EXTERNAL_PACKAGES);
    expect(patched).toBe(true);

    const content = readFileSync(join(tmpDir, "next.config.ts"), "utf-8");
    expect(content).toContain("serverExternalPackages");
    expect(content).toContain("@opentelemetry/auto-instrumentations-node");
    expect(content).toContain("require-in-the-middle");
  });

  it("injects serverExternalPackages into next.config.js (module.exports)", () => {
    writeFileSync(
      join(tmpDir, "next.config.js"),
      'const nextConfig = {};\nmodule.exports = nextConfig;\n',
    );
    const patched = patchNextConfig(tmpDir, NEXTJS_SERVER_EXTERNAL_PACKAGES);
    expect(patched).toBe(true);

    const content = readFileSync(join(tmpDir, "next.config.js"), "utf-8");
    expect(content).toContain("serverExternalPackages");
  });

  it("injects serverExternalPackages into next.config.mjs (export default)", () => {
    writeFileSync(
      join(tmpDir, "next.config.mjs"),
      "const nextConfig = {};\nexport default nextConfig;\n",
    );
    const patched = patchNextConfig(tmpDir, NEXTJS_SERVER_EXTERNAL_PACKAGES);
    expect(patched).toBe(true);

    const content = readFileSync(join(tmpDir, "next.config.mjs"), "utf-8");
    expect(content).toContain("serverExternalPackages");
  });

  it("returns false when next.config already contains serverExternalPackages", () => {
    writeFileSync(
      join(tmpDir, "next.config.ts"),
      'const nextConfig = { serverExternalPackages: ["some-pkg"] };\nexport default nextConfig;\n',
    );
    const patched = patchNextConfig(tmpDir, NEXTJS_SERVER_EXTERNAL_PACKAGES);
    expect(patched).toBe(false);

    // Content should be unchanged
    const content = readFileSync(join(tmpDir, "next.config.ts"), "utf-8");
    expect(content).toContain('"some-pkg"');
    expect(content).not.toContain("require-in-the-middle");
  });

  it("returns false when no next.config file exists", () => {
    const patched = patchNextConfig(tmpDir, NEXTJS_SERVER_EXTERNAL_PACKAGES);
    expect(patched).toBe(false);
  });

  it("warns and returns false for wrapper-function configs (e.g. withSentryConfig)", () => {
    writeFileSync(
      join(tmpDir, "next.config.ts"),
      'import withSentry from "@sentry/nextjs";\nexport default withSentry({});\n',
    );
    const stdoutChunks: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    const patched = patchNextConfig(tmpDir, NEXTJS_SERVER_EXTERNAL_PACKAGES);
    spy.mockRestore();

    expect(patched).toBe(false);
    const combined = stdoutChunks.join("");
    expect(combined).toContain("could not auto-patch");
    expect(combined).toContain("serverExternalPackages");
  });
});
