import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { detectFramework } from "./init/detect-framework.js";
import { detectLogger } from "./init/detect-logger.js";
import { detectPackageManager } from "./init/detect-package-manager.js";
import { getInstrumentationTemplate } from "./init/templates.js";
import { patchScripts } from "./init/patch-scripts.js";
import { resolveApiKey } from "./init/credentials.js";

const OTEL_DEPS = [
  "@opentelemetry/sdk-node",
  "@opentelemetry/auto-instrumentations-node",
  "@opentelemetry/exporter-trace-otlp-http",
  "@opentelemetry/exporter-metrics-otlp-http",
  "@opentelemetry/exporter-logs-otlp-http",
  "@opentelemetry/sdk-logs",
  "@opentelemetry/sdk-metrics",
];

function getInstallCommand(pm: string, deps: string[]): string {
  const depsStr = deps.join(" ");
  switch (pm) {
    case "pnpm": return `pnpm add ${depsStr}`;
    case "yarn": return `yarn add ${depsStr}`;
    case "bun": return `bun add ${depsStr}`;
    default: return `npm install ${depsStr}`;
  }
}

/**
 * Returns true if the project is TypeScript (has typescript dep or tsconfig.json).
 */
export function isTypeScriptProject(
  cwd: string,
  allDeps: Record<string, string>,
): boolean {
  if ("typescript" in allDeps) return true;
  if (existsSync(join(cwd, "tsconfig.json"))) return true;
  return false;
}

/**
 * Returns true if the project is ESM (package.json has "type": "module").
 */
export function isEsmProject(pkg: { type?: string }): boolean {
  return pkg.type === "module";
}

/**
 * Update .env content idempotently.
 * - Key doesn't exist → append
 * - Key exists with empty value (KEY= or KEY) → overwrite
 * - Key exists with non-empty value → preserve (skip)
 */
export function updateEnvFile(
  content: string,
  updates: Record<string, string>,
): string {
  let result = content;
  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=(.*?)$`, "m");
    const match = regex.exec(result);
    const line = `${key}=${value}`;
    if (match) {
      // Key exists — only overwrite if current value is empty
      if (match[1]!.trim() === "") {
        result = result.replace(regex, line);
      }
      // else: preserve existing non-empty value
    } else {
      result = result.endsWith("\n") ? result + line + "\n" : result + "\n" + line + "\n";
    }
  }
  return result;
}

/**
 * Ensure .gitignore contains .env entry.
 * Creates .gitignore if it doesn't exist.
 */
export function ensureGitignore(cwd: string): void {
  const gitignorePath = join(cwd, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, ".env\n", "utf-8");
    process.stdout.write("Created .gitignore with .env entry\n");
    return;
  }

  const content = readFileSync(gitignorePath, "utf-8");
  const lines = content.split("\n").map((l) => l.trim());
  if (lines.includes(".env")) return;

  const updated = content.endsWith("\n") ? content + ".env\n" : content + "\n.env\n";
  writeFileSync(gitignorePath, updated, "utf-8");
  process.stdout.write("Added .env to .gitignore\n");
}

function isDockerInstalled(): boolean {
  try {
    execSync("docker --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface InitOptions {
  apiKey?: string;
  noInteractive?: boolean;
}

type PackageJson = {
  name?: string;
  type?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

export async function runInit(_argv: string[], options: InitOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const pkgPath = join(cwd, "package.json");

  if (!existsSync(pkgPath)) {
    process.stderr.write("Error: no package.json found in current directory\n");
    process.exit(1);
    return;
  }

  let pkg: PackageJson;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as PackageJson;
  } catch {
    process.stderr.write("Error: could not parse package.json\n");
    process.exit(1);
    return;
  }

  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  const framework = detectFramework(allDeps);
  const logger = detectLogger(allDeps);
  const pm = detectPackageManager(cwd);
  const serviceName = pkg.name ?? "my-service";
  const isTs = isTypeScriptProject(cwd, allDeps);
  const isEsm = isEsmProject(pkg);
  const isNextjs = framework === "nextjs";

  // --- 1. Install deps (backup package.json for rollback on failure) ---
  const pkgBackupPath = pkgPath + ".bak";
  copyFileSync(pkgPath, pkgBackupPath);

  const depsToInstall = [...OTEL_DEPS];
  if (logger.detected) {
    depsToInstall.push(logger.instrumentationPackage);
  }
  const installCmd = getInstallCommand(pm, depsToInstall);
  process.stdout.write(`Installing OTel dependencies: ${installCmd}\n`);

  try {
    execSync(installCmd, { cwd, stdio: "inherit" });
  } catch (err) {
    process.stderr.write(`Error: dependency install failed: ${String(err)}\n`);
    copyFileSync(pkgBackupPath, pkgPath);
    process.stderr.write("package.json restored.\n");
    process.stderr.write(`Run manually: ${installCmd}\n`);
    process.exit(1);
    return;
  }

  try {
    unlinkSync(pkgBackupPath);
  } catch {
    // backup cleanup failure is non-fatal
  }

  // --- 2. Generate instrumentation file ---
  const instrumentationExt = isTs ? ".ts" : ".js";
  const instrumentationFile = `instrumentation${instrumentationExt}`;
  const instrumentationPath = join(cwd, instrumentationFile);

  if (existsSync(instrumentationPath)) {
    process.stdout.write(`${instrumentationFile} already exists — skipping.\n`);
  } else {
    const template = getInstrumentationTemplate(framework);
    writeFileSync(instrumentationPath, template, "utf-8");
    process.stdout.write(`Created ${instrumentationFile}\n`);
  }

  // --- 3. Patch package.json scripts ---
  // Re-read package.json after dep install (lockfile changes, deps added)
  const updatedPkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as PackageJson;
  const patchResult = patchScripts(updatedPkg.scripts, instrumentationFile, isNextjs, isEsm);

  if (Object.keys(patchResult.patched).length > 0) {
    process.stdout.write("\nPatching package.json scripts:\n");
    for (const [name, newScript] of Object.entries(patchResult.patched)) {
      process.stdout.write(`  ${name}: "${updatedPkg.scripts![name]}" → "${newScript}"\n`);
      updatedPkg.scripts![name] = newScript;
    }
    writeFileSync(pkgPath, JSON.stringify(updatedPkg, null, 2) + "\n", "utf-8");
    process.stdout.write("package.json scripts updated.\n");
  }

  for (const { name, reason } of patchResult.skipped) {
    process.stdout.write(`  ${name}: skipped (${reason})\n`);
  }

  // --- 4. Update .env (idempotent — preserves existing values) ---
  const envPath = join(cwd, ".env");
  const envContent = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  const updatedEnv = updateEnvFile(envContent, {
    OTEL_SERVICE_NAME: serviceName,
    OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=development",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:3333",
    OTEL_EXPORTER_OTLP_HEADERS: "",
  });
  writeFileSync(envPath, updatedEnv, "utf-8");
  process.stdout.write("Updated .env\n");

  // --- 5. Ensure .gitignore includes .env ---
  ensureGitignore(cwd);

  // --- 6. ANTHROPIC_API_KEY ---
  const apiKey = await resolveApiKey({
    apiKey: options.apiKey,
    noInteractive: options.noInteractive,
  });

  if (apiKey) {
    process.stdout.write("ANTHROPIC_API_KEY configured.\n");
  } else {
    process.stderr.write(
      "Warning: ANTHROPIC_API_KEY not configured.\n" +
      "LLM diagnosis will not run until you set it.\n" +
      "Fix: npx 3amoncall init --api-key <your-key>\n",
    );
  }

  // --- 7. Signal check ---
  process.stdout.write("\n3amoncall init complete!\n\n");
  process.stdout.write("Signal check:\n");
  process.stdout.write("  ✓ Traces — auto-instrumented (HTTP, DB, etc.)\n");
  process.stdout.write("  ✓ Metrics — auto-instrumented (request duration, etc.)\n");
  if (logger.detected) {
    process.stdout.write(`  ✓ Logs — ${logger.name} detected, bridge installed\n`);
  } else {
    process.stdout.write(
      "  ✗ Logs — no structured logger detected. Install pino or winston for log-based diagnosis.\n",
    );
  }
  process.stdout.write("\n");

  // --- 8. Startup guidance ---
  if (isNextjs) {
    process.stdout.write(
      "Next.js detected: instrumentation.ts uses register() export — Next.js loads it automatically.\n",
    );
  } else if (Object.keys(patchResult.patched).length > 0) {
    process.stdout.write("Scripts already patched — instrumentation loads automatically on start.\n");
  } else if (isEsm) {
    process.stdout.write(
      `Add --import to your startup command:\n` +
      `  node --import ./${instrumentationFile} app.js\n`,
    );
  } else {
    process.stdout.write(
      `Add --require to your startup command:\n` +
      `  node --require ./${instrumentationFile} app.js\n`,
    );
  }

  // --- 9. Start local Receiver ---
  if (isDockerInstalled()) {
    process.stdout.write("\nStarting local Receiver...\n");
    try {
      // Import dynamically to avoid circular dependency issues in tests
      const { runDev } = await import("./dev.js");
      runDev({ apiKey });
    } catch {
      process.stderr.write(
        "Warning: failed to start Receiver container.\n" +
        "Fix: run `npx 3amoncall dev` manually after resolving the issue.\n",
      );
    }
  } else {
    process.stdout.write(
      "\nDocker not found — skipping Receiver startup.\n" +
      "Install Docker (Docker Desktop, OrbStack, Podman, or colima) and run `npx 3amoncall dev`.\n",
    );
  }
}
