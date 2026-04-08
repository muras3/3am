import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { detectFramework } from "./init/detect-framework.js";
import { detectLogger } from "./init/detect-logger.js";
import { detectPackageManager } from "./init/detect-package-manager.js";
import { getInstrumentationTemplate, nextjsVercelTemplate } from "./init/templates.js";
import { patchScripts } from "./init/patch-scripts.js";
import { detectRuntimeTarget, findWranglerConfigPath } from "./init/detect-runtime.js";
import { updateCloudflareObservabilityConfig } from "./cloudflare-workers.js";
import { resolveApiKey, loadCredentials, saveCredentials } from "./init/credentials.js";
import { createInterface } from "node:readline";
import { PROVIDER_NAMES, type ProviderName } from "@3am/diagnosis";

const OTEL_DEPS = [
  "@opentelemetry/sdk-node",
  "@opentelemetry/auto-instrumentations-node",
  "@opentelemetry/exporter-trace-otlp-http",
  "@opentelemetry/exporter-metrics-otlp-http",
  "@opentelemetry/exporter-logs-otlp-http",
  "@opentelemetry/sdk-logs",
  "@opentelemetry/sdk-metrics",
];

const VERCEL_OTEL_DEPS = [
  "@vercel/otel",
  "@opentelemetry/api",
  "@opentelemetry/api-logs",
  "@opentelemetry/auto-instrumentations-node",
  "@opentelemetry/exporter-trace-otlp-http",
  "@opentelemetry/exporter-metrics-otlp-http",
  "@opentelemetry/exporter-logs-otlp-http",
  "@opentelemetry/instrumentation-bunyan",
  "@opentelemetry/instrumentation-pino",
  "@opentelemetry/instrumentation-winston",
  "@opentelemetry/sdk-metrics",
  "@opentelemetry/sdk-logs",
  "@opentelemetry/winston-transport",
];

const VERCEL_SERVER_EXTERNAL_PACKAGES = [
  "pino",
  "winston",
  "bunyan",
  "@opentelemetry/auto-instrumentations-node",
  "@opentelemetry/instrumentation-pino",
  "@opentelemetry/instrumentation-winston",
  "@opentelemetry/instrumentation-bunyan",
  "require-in-the-middle",
];

function isDirectory(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function findNextConfigPath(cwd: string): string | null {
  for (const name of ["next.config.ts", "next.config.mjs", "next.config.js", "next.config.cjs"]) {
    const p = join(cwd, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Add serverExternalPackages to next.config for OTel compatibility.
 * Webpack bundling breaks require-in-the-middle monkey-patching unless
 * these packages are externalized.
 */
function patchNextConfig(cwd: string): boolean {
  const configPath = findNextConfigPath(cwd);
  if (!configPath) return false;

  let content = readFileSync(configPath, "utf-8");
  if (content.includes("serverExternalPackages")) return false;

  const packageList = VERCEL_SERVER_EXTERNAL_PACKAGES
    .map((p) => `    "${p}",`)
    .join("\n");
  const property = `\n  serverExternalPackages: [\n${packageList}\n  ],`;

  // Match the opening brace of the config object.
  // Covers: `const nextConfig: NextConfig = {`, `module.exports = {`, `export default {`
  const configObjectPattern = /(?:NextConfig\s*=|nextConfig\s*=|module\.exports\s*=|export\s+default\s*)\s*\{/;
  const match = configObjectPattern.exec(content);
  if (!match) {
    // Wrapper functions like withSentryConfig({...}) need manual patching
    process.stdout.write(
      "  Warning: could not auto-patch next.config — add serverExternalPackages manually.\n" +
      `  Required packages: ${VERCEL_SERVER_EXTERNAL_PACKAGES.join(", ")}\n`,
    );
    return false;
  }

  const insertPos = match.index + match[0].length;
  content = content.slice(0, insertPos) + property + content.slice(insertPos);
  writeFileSync(configPath, content, "utf-8");
  return true;
}

/**
 * Change `next build` to `next build --webpack` in package.json.
 * Turbopack renames module identifiers, breaking require-in-the-middle
 * monkey-patching used by OTel auto-instrumentations.
 */
function patchBuildScript(pkgPath: string): boolean {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as PackageJson;
  const buildScript = pkg.scripts?.build;
  if (!buildScript || !buildScript.includes("next build") || buildScript.includes("--webpack")) {
    return false;
  }
  pkg.scripts!.build = buildScript.replace("next build", "next build --webpack");
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
  return true;
}

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
  lang?: string;
  mode?: string;
  provider?: string;
  model?: string;
  bridgeUrl?: string;
  noInteractive?: boolean;
  /** Pre-supply a webhook URL (skips interactive prompt; used in tests and CI) */
  webhookUrl?: string;
}

function isProviderName(value: string | undefined): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value ?? "");
}

function resolveLocale(value: string | undefined): "en" | "ja" | undefined {
  if (value === "en" || value === "ja") {
    return value;
  }
  return undefined;
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
  const runtimeTarget = detectRuntimeTarget(cwd);
  const wranglerConfigPath = findWranglerConfigPath(cwd);
  const serviceName = pkg.name ?? "my-service";
  const isTs = isTypeScriptProject(cwd, allDeps);
  const isEsm = isEsmProject(pkg);
  const isNextjs = framework === "nextjs";
  const instrumentationExt = isTs ? ".ts" : ".js";
  const instrumentationFile = `instrumentation${instrumentationExt}`;
  const patchResult = { patched: {}, skipped: [] } as ReturnType<typeof patchScripts>;

  if (runtimeTarget === "cloudflare-workers") {
    if (!wranglerConfigPath) {
      process.stderr.write("Error: Cloudflare Workers project detected, but no wrangler config was found.\n");
      process.exit(1);
      return;
    }
    const changed = updateCloudflareObservabilityConfig(wranglerConfigPath);
    process.stdout.write(
      changed
        ? `Updated ${wranglerConfigPath.split("/").pop()} with Workers Observability settings\n`
        : `${wranglerConfigPath.split("/").pop()} already contains Workers Observability settings\n`,
    );
  } else {
    // --- 1. Install deps (backup package.json for rollback on failure) ---
    const pkgBackupPath = pkgPath + ".bak";
    copyFileSync(pkgPath, pkgBackupPath);

    const isVercelProject = existsSync(join(cwd, '.vercel')) || existsSync(join(cwd, 'vercel.json'));
    const useVercelOtel = isNextjs && isVercelProject;

    const depsToInstall = useVercelOtel ? [...VERCEL_OTEL_DEPS] : [...OTEL_DEPS];
    if (!useVercelOtel && logger.detected) {
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
    // Next.js with src/ directory requires instrumentation file in src/
    const hasSrcDir = isNextjs && isDirectory(join(cwd, 'src'));
    const instrumentationDir = hasSrcDir ? join(cwd, 'src') : cwd;
    const instrumentationPath = join(instrumentationDir, instrumentationFile);

    if (existsSync(instrumentationPath)) {
      process.stdout.write(`${instrumentationFile} already exists — skipping.\n`);
    } else {
      const template = useVercelOtel
        ? nextjsVercelTemplate()
        : getInstrumentationTemplate(framework);
      writeFileSync(instrumentationPath, template, "utf-8");
      const relPath = hasSrcDir ? `src/${instrumentationFile}` : instrumentationFile;
      process.stdout.write(`Created ${relPath}\n`);
    }

    // --- 2b. Vercel/Next.js: patch next.config + build script ---
    if (useVercelOtel) {
      const nextConfigPath = findNextConfigPath(cwd);
      if (nextConfigPath) {
        if (patchNextConfig(cwd)) {
          process.stdout.write(`Added serverExternalPackages to ${nextConfigPath.split("/").pop()}\n`);
        }
      } else {
        process.stdout.write(
          "  Warning: no next.config found — create one and add serverExternalPackages.\n" +
          `  Required packages: ${VERCEL_SERVER_EXTERNAL_PACKAGES.join(", ")}\n`,
        );
      }
      if (patchBuildScript(pkgPath)) {
        process.stdout.write(`Changed build script to use --webpack (required for OTel)\n`);
      } else {
        // Re-read to check current state
        const currentPkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as PackageJson;
        const buildScript = currentPkg.scripts?.build ?? "";
        if (buildScript.includes("--webpack")) {
          // Already patched — no warning needed
        } else if (buildScript.includes("next build")) {
          // Should have been patched but wasn't — unexpected
        } else if (buildScript) {
          process.stdout.write(
            `  Warning: build script "${buildScript}" does not use \`next build\` — add --webpack manually if needed.\n`,
          );
        }
      }
    }

    // --- 3. Patch package.json scripts ---
    // Re-read package.json after dep install (lockfile changes, deps added)
    const updatedPkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as PackageJson;
    const nodePatchResult = patchScripts(updatedPkg.scripts, instrumentationFile, isNextjs, isEsm);
    patchResult.patched = nodePatchResult.patched;
    patchResult.skipped = nodePatchResult.skipped;

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
  }

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
      "Fix: npx 3am init --api-key <your-key>\n",
    );
  }

  // --- 6b. Language + diagnosis settings ---
  const storedCreds = loadCredentials();
  let locale: "en" | "ja" = resolveLocale(options.lang)
    ?? (storedCreds.locale === "ja" ? "ja" : "en");
  let mode: "automatic" | "manual" = options.mode === "manual"
    ? "manual"
    : options.mode === "automatic"
      ? "automatic"
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
      rlProvider.question(`LLM provider (${PROVIDER_NAMES.join("/")}) [anthropic]: `, (answer) => {
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

  // --- 6c. Notification webhook URL ---
  // Helper: validate, persist, and test a webhook URL
  async function processWebhookUrl(webhookAnswer: string): Promise<void> {
    if (!webhookAnswer) return;
    try {
      const parsed = new URL(webhookAnswer);
      const hostname = parsed.hostname;
      if (
        hostname === "hooks.slack.com" ||
        hostname === "discord.com" ||
        hostname === "discordapp.com"
      ) {
        const envPath2 = join(cwd, ".env");
        const envContent2 = existsSync(envPath2) ? readFileSync(envPath2, "utf-8") : "";
        const updatedEnv2 = updateEnvFile(envContent2, {
          NOTIFICATION_WEBHOOK_URL: webhookAnswer,
        });
        writeFileSync(envPath2, updatedEnv2, "utf-8");
        process.stdout.write(
          ja
            ? `通知先: ${hostname} に設定しました\n`
            : `Notifications: configured for ${hostname}\n`,
        );
        // Send a test notification to verify the webhook works
        try {
          const isDiscord = hostname === "discord.com" || hostname === "discordapp.com";
          const testPayload = isDiscord
            ? { content: "✓ 3am connected! Incident notifications will appear here." }
            : { text: "✓ 3am connected! Incident notifications will appear here." };
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10_000);
          let testOk = false;
          let testError: string | undefined;
          try {
            const res = await fetch(webhookAnswer, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(testPayload),
              signal: controller.signal,
            });
            clearTimeout(timer);
            testOk = res.ok;
            if (!res.ok) testError = `HTTP ${res.status}`;
          } catch (err) {
            clearTimeout(timer);
            testError = err instanceof Error ? err.message : String(err);
          }
          if (testOk) {
            process.stdout.write(
              ja ? "  → テストメッセージ送信 ✓\n" : "  → Test message sent ✓\n",
            );
          } else {
            process.stdout.write(
              ja
                ? `  → テストメッセージ送信失敗: ${testError}。URLを確認して再試行してください。\n`
                : `  → Test message failed: ${testError}. Check the URL and try again.\n`,
            );
          }
        } catch {
          // Unexpected error during test send — non-fatal, continue
        }
      } else {
        process.stdout.write(
          ja
            ? "無効なwebhook URL。Slack または Discord のwebhook URLを使用してください。\n"
            : "Invalid webhook URL. Use a Slack or Discord webhook URL.\n",
        );
      }
    } catch {
      if (webhookAnswer.length > 0) {
        process.stdout.write(
          ja
            ? "無効なURL形式です。スキップします。\n"
            : "Invalid URL format. Skipping.\n",
        );
      }
    }
  }

  if (options.webhookUrl) {
    // Pre-supplied URL (non-interactive / CI mode)
    await processWebhookUrl(options.webhookUrl);
  } else if (!options.noInteractive && process.stdin.isTTY) {
    const rl2 = createInterface({ input: process.stdin, output: process.stdout });
    const webhookAnswer = await new Promise<string>((resolve) => {
      rl2.question(
        ja
          ? "Slack/Discord webhook URL (後で設定する場合は空Enter): "
          : "Slack/Discord webhook URL (press Enter to skip): ",
        (answer) => {
          rl2.close();
          resolve(answer.trim());
        },
      );
    });
    await processWebhookUrl(webhookAnswer);
  }

  // --- 7. Signal check ---
  process.stdout.write(ja ? "\n3am init 完了!\n\n" : "\n3am init complete!\n\n");
  if (runtimeTarget === "cloudflare-workers") {
    process.stdout.write(ja ? "実行基盤: Cloudflare Workers\n" : "Runtime target: Cloudflare Workers\n");
  }
  process.stdout.write(ja ? "シグナル確認:\n" : "Signal check:\n");
  if (runtimeTarget === "cloudflare-workers") {
    process.stdout.write(ja
      ? "  ✓ トレース — Workers Observability 経由で export\n"
      : "  ✓ Traces — exported via Workers Observability\n");
    process.stdout.write(ja
      ? "  ✓ ログ — Workers Observability 経由で export (console.log を含む)\n"
      : "  ✓ Logs — exported via Workers Observability (including console.log)\n");
    process.stdout.write(ja
      ? "  ✗ メトリクス — Cloudflare OTLP export は現時点で未対応\n"
      : "  ✗ Metrics — Cloudflare OTLP export is not supported today\n");
  } else {
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
  }
  process.stdout.write("\n");

  // --- 8. Startup guidance ---
  if (runtimeTarget === "cloudflare-workers") {
    process.stdout.write(ja
      ? `Cloudflare Workers を検出: ${wranglerConfigPath?.split("/").pop()} に Workers Observability を設定しました。\n`
      : `Cloudflare Workers detected: configured Workers Observability in ${wranglerConfigPath?.split("/").pop()}.\n`);
  } else if (isNextjs) {
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
      ? runtimeTarget === "cloudflare-workers"
        ? "\n次のステップ:\n  1. Cloudflare の OTLP destination を 3am receiver に向ける\n  2. `wrangler deploy`\n  3. リクエストを発生させて traces/logs の到達を確認する\n"
        : mode === "manual"
          ? "\n次のステップ:\n  1. `npx 3am local`\n  2. 別ターミナルで `npx 3am bridge`\n  3. `npx 3am local demo`\n"
          : "\n次のステップ:\n  1. `npx 3am local`\n  2. 別ターミナルで `npx 3am local demo`\n"
      : runtimeTarget === "cloudflare-workers"
        ? "\nNext steps:\n  1. Point your Cloudflare OTLP destination at the 3am receiver\n  2. `wrangler deploy`\n  3. Trigger a request and confirm traces/logs arrive\n"
        : mode === "manual"
          ? "\nNext steps:\n  1. `npx 3am local`\n  2. In another terminal, `npx 3am bridge`\n  3. `npx 3am local demo`\n"
          : "\nNext steps:\n  1. `npx 3am local`\n  2. In another terminal, `npx 3am local demo`\n",
  );
}
