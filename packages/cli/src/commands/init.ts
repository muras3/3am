import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { detectFramework } from "./init/detect-framework.js";
import { detectLogger } from "./init/detect-logger.js";
import { detectPackageManager } from "./init/detect-package-manager.js";
import { getInstrumentationTemplate } from "./init/templates.js";
import { patchScripts } from "./init/patch-scripts.js";
import { resolveApiKey, loadCredentials, saveCredentials } from "./init/credentials.js";
import { createInterface } from "node:readline";
import type { ProviderName } from "@3amoncall/diagnosis";

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

export interface InitOptions {
  apiKey?: string;
  mode?: string;
  provider?: string;
  model?: string;
  bridgeUrl?: string;
  noInteractive?: boolean;
}

function isProviderName(value: string | undefined): value is ProviderName {
  return value === "anthropic"
    || value === "openai"
    || value === "ollama"
    || value === "claude-code"
    || value === "codex";
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
      "Anthropic automatic diagnosis will not run until you set it.\n" +
      "Fix: npx 3amoncall init --api-key <your-key>\n",
    );
  }

  // --- 6b. Language + diagnosis settings ---
  const storedCreds = loadCredentials();
  let locale: "en" | "ja" = storedCreds.locale === "ja" ? "ja" : "en";
  let mode: "automatic" | "manual" = options.mode === "manual"
    ? "manual"
    : storedCreds.llmMode === "manual"
      ? "manual"
      : "automatic";
  let provider: ProviderName = isProviderName(options.provider)
    ? options.provider
    : isProviderName(storedCreds.llmProvider)
      ? storedCreds.llmProvider
      : "anthropic";
  if (!options.noInteractive && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const localeAnswer = await new Promise<string>((resolve) => {
      rl.question("Preferred language / 言語選択 (en/ja) [en]: ", (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase() || "en");
      });
    });
    locale = localeAnswer === "ja" ? "ja" : "en";
    process.stdout.write(locale === "ja" ? `言語: 日本語\n` : `Language: English\n`);

    const rlMode = createInterface({ input: process.stdin, output: process.stdout });
    const modeAnswer = await new Promise<string>((resolve) => {
      rlMode.question("Diagnosis mode (automatic/manual) [automatic]: ", (answer) => {
        rlMode.close();
        resolve(answer.trim().toLowerCase() || "automatic");
      });
    });
    mode = modeAnswer === "manual" ? "manual" : "automatic";

    const rlProvider = createInterface({ input: process.stdin, output: process.stdout });
    const providerAnswer = await new Promise<string>((resolve) => {
      rlProvider.question("LLM provider (anthropic/openai/ollama/claude-code/codex) [anthropic]: ", (answer) => {
        rlProvider.close();
        resolve(answer.trim().toLowerCase() || "anthropic");
      });
    });
    provider = isProviderName(providerAnswer) ? providerAnswer : "anthropic";
  }

  saveCredentials({
    ...storedCreds,
    locale,
    llmMode: mode,
    llmProvider: provider,
    llmBridgeUrl: options.bridgeUrl ?? storedCreds.llmBridgeUrl ?? "http://127.0.0.1:4269",
    llmModel: options.model ?? storedCreds.llmModel,
  });

  const ja = locale === "ja";

  // --- 7. Signal check ---
  process.stdout.write(ja ? "\n3amoncall init 完了!\n\n" : "\n3amoncall init complete!\n\n");
  process.stdout.write(ja ? "シグナル確認:\n" : "Signal check:\n");
  process.stdout.write(ja
    ? "  ✓ トレース — 自動計装 (HTTP, DB 等)\n"
    : "  ✓ Traces — auto-instrumented (HTTP, DB, etc.)\n");
  process.stdout.write(ja
    ? "  ✓ メトリクス — 自動計装 (リクエスト所要時間等)\n"
    : "  ✓ Metrics — auto-instrumented (request duration, etc.)\n");
  if (logger.detected) {
    process.stdout.write(ja
      ? `  ✓ ログ — ${logger.name} 検出済み、ブリッジをインストール\n`
      : `  ✓ Logs — ${logger.name} detected, bridge installed\n`);
  } else {
    process.stdout.write(ja
      ? "  ✗ ログ — 構造化ロガー未検出。ログ診断には pino か winston をインストールしてください。\n"
      : "  ✗ Logs — no structured logger detected. Install pino or winston for log-based diagnosis.\n");
  }
  process.stdout.write("\n");

  // --- 8. Startup guidance ---
  if (isNextjs) {
    process.stdout.write(ja
      ? "Next.js を検出: instrumentation.ts の register() を使用 — Next.js が自動的に読み込みます。\n"
      : "Next.js detected: instrumentation.ts uses register() export — Next.js loads it automatically.\n");
  } else if (Object.keys(patchResult.patched).length > 0) {
    process.stdout.write(ja
      ? "scripts パッチ適用済み — 起動時に自動で計装が読み込まれます。\n"
      : "Scripts already patched — instrumentation loads automatically on start.\n");
  } else if (isEsm) {
    process.stdout.write(ja
      ? `起動コマンドに --import を追加:\n  node --import ./${instrumentationFile} app.js\n`
      : `Add --import to your startup command:\n  node --import ./${instrumentationFile} app.js\n`);
  } else {
    process.stdout.write(ja
      ? `起動コマンドに --require を追加:\n  node --require ./${instrumentationFile} app.js\n`
      : `Add --require to your startup command:\n  node --require ./${instrumentationFile} app.js\n`);
  }

  process.stdout.write(
    ja
      ? mode === "manual"
        ? "\n次のステップ:\n  1. `npx 3amoncall local`\n  2. 別ターミナルで `npx 3amoncall bridge`\n  3. `npx 3amoncall local demo`\n"
        : "\n次のステップ:\n  1. `npx 3amoncall local`\n  2. 別ターミナルで `npx 3amoncall local demo`\n"
      : mode === "manual"
        ? "\nNext steps:\n  1. `npx 3amoncall local`\n  2. In another terminal, `npx 3amoncall bridge`\n  3. `npx 3amoncall local demo`\n"
        : "\nNext steps:\n  1. `npx 3amoncall local`\n  2. In another terminal, `npx 3amoncall local demo`\n",
  );
}
