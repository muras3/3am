import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCredentials } from "./init/credentials.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getCLIVersion(): string {
  try {
    // Resolve package.json relative to this file's location.
    // Works both from src/ (dev) and dist/commands/ (published):
    //   src/commands/dev.ts  -> ../../package.json
    //   dist/commands/dev.js -> ../../package.json
    const pkgPath = resolve(__dirname, "../../package.json");
    return JSON.parse(readFileSync(pkgPath, "utf-8")).version as string;
  } catch {
    return "0.0.0-unknown";
  }
}

function resolveLocalRepoRoot(): string | null {
  const candidate = resolve(__dirname, "../../../../");
  const rootPackageJson = join(candidate, "package.json");
  const receiverPackageJson = join(candidate, "apps", "receiver", "package.json");

  if (existsSync(rootPackageJson) && existsSync(receiverPackageJson)) {
    return candidate;
  }

  return null;
}

function isDockerInstalled(): boolean {
  try {
    execSync("docker --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function isPnpmInstalled(): boolean {
  try {
    execSync("pnpm --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function loadEnvApiKey(cwd: string): string | undefined {
  const envPath = join(cwd, ".env");
  if (!existsSync(envPath)) return undefined;
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eqIdx = trimmed.indexOf("=");
    const key = trimmed.slice(0, eqIdx).trim();
    if (key === "ANTHROPIC_API_KEY") {
      return trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  return undefined;
}

export interface DevOptions {
  port?: number;
  /** Pre-resolved API key (from init flow). Falls back to env/credentials/.env if not provided. */
  apiKey?: string;
}

function buildRuntimeEnv(
  port: number,
  creds: ReturnType<typeof loadCredentials>,
  apiKey: string | undefined,
  repoRoot?: string,
): NodeJS.ProcessEnv {
  const runtimeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    ALLOW_INSECURE_DEV_MODE: "true",
    DIAGNOSIS_GENERATION_THRESHOLD: "0",
    DIAGNOSIS_MAX_WAIT_MS: "0",
  };

  if (creds.llmMode) {
    runtimeEnv["LLM_MODE"] = creds.llmMode;
  }
  if (creds.llmProvider) {
    runtimeEnv["LLM_PROVIDER"] = creds.llmProvider;
  }
  if (creds.llmBridgeUrl) {
    runtimeEnv["LLM_BRIDGE_URL"] = creds.llmBridgeUrl;
  }
  if (apiKey) {
    runtimeEnv["ANTHROPIC_API_KEY"] = apiKey;
  }
  if (process.env["NOTIFICATION_WEBHOOK_URL"]) {
    runtimeEnv["NOTIFICATION_WEBHOOK_URL"] = process.env["NOTIFICATION_WEBHOOK_URL"];
  }
  if (process.env["CONSOLE_BASE_URL"]) {
    runtimeEnv["CONSOLE_BASE_URL"] = process.env["CONSOLE_BASE_URL"];
  }
  if (repoRoot) {
    runtimeEnv["CONSOLE_DIST_PATH"] = join(repoRoot, "apps", "console", "dist");
  }

  return runtimeEnv;
}

function ensureLocalWorkspaceReady(repoRoot: string): string {
  if (!existsSync(join(repoRoot, "node_modules"))) {
    throw new Error(
      `3am monorepo detected at ${repoRoot}, but dependencies are not installed.\n` +
        "Run `pnpm install` in the repo root, then re-run `npx 3am local`.",
    );
  }

  if (!isPnpmInstalled()) {
    throw new Error(
      "pnpm is required to start the cloned 3am monorepo locally.\n" +
        "Install pnpm, then re-run `npx 3am local`.",
    );
  }

  const buildTargets: Array<{ name: string; marker: string }> = [
    { name: "3am-core", marker: join(repoRoot, "packages", "core", "dist", "index.js") },
    { name: "3am-diagnosis", marker: join(repoRoot, "packages", "diagnosis", "dist", "index.js") },
    { name: "@3am/console", marker: join(repoRoot, "apps", "console", "dist", "index.html") },
  ];

  const missingTargets = buildTargets.filter((target) => !existsSync(target.marker));
  if (missingTargets.length > 0) {
    process.stdout.write("Preparing local 3am workspace artifacts...\n");
    for (const target of missingTargets) {
      execSync(`pnpm --filter ${target.name} build`, {
        cwd: repoRoot,
        stdio: "inherit",
      });
    }
  }

  return join(repoRoot, "apps", "console", "dist");
}

function runLocalSourceReceiver(repoRoot: string, runtimeEnv: NodeJS.ProcessEnv): void {
  runtimeEnv["CONSOLE_DIST_PATH"] = ensureLocalWorkspaceReady(repoRoot);
  process.stdout.write(`Detected local 3am monorepo at ${repoRoot}\n`);
  process.stdout.write(`Starting 3am receiver from source on http://localhost:${runtimeEnv["PORT"]}\n`);

  const result = spawnSync("pnpm", ["--filter", "@3am/receiver", "dev"], {
    cwd: repoRoot,
    env: runtimeEnv,
    stdio: "inherit",
  });

  if (result.error) {
    process.stderr.write(`Error: failed to start local receiver from source: ${result.error.message}\n`);
    process.exit(1);
    return;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

export function runDev(options: DevOptions = {}): void {
  const port = options.port ?? 3333;
  const version = getCLIVersion();
  const repoRoot = resolveLocalRepoRoot();

  if (!repoRoot && !isDockerInstalled()) {
    process.stderr.write(
      "Error: Docker is a product prerequisite for local development.\n" +
        "Install Docker Desktop: https://www.docker.com/products/docker-desktop/\n",
    );
    process.exit(1);
    return;
  }

  const creds = loadCredentials();
  const apiKey = options.apiKey
    ?? process.env["ANTHROPIC_API_KEY"]
    ?? creds.anthropicApiKey
    ?? loadEnvApiKey(process.cwd());

  if (!apiKey) {
    process.stderr.write(
      "Warning: ANTHROPIC_API_KEY not found in environment or .env file.\n" +
        "LLM diagnosis will not run until you set ANTHROPIC_API_KEY.\n",
    );
  }

  const runtimeEnv = buildRuntimeEnv(port, creds, apiKey, repoRoot ?? undefined);

  if (repoRoot) {
    try {
      runLocalSourceReceiver(repoRoot, runtimeEnv);
    } catch (error) {
      process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
    return;
  }

  const image = `ghcr.io/3am/receiver:v${version}`;
  const args = [
    "run",
    "--rm",
    "-p",
    `${port}:3000`,
  ];

  for (const [key, value] of Object.entries(runtimeEnv)) {
    if (value == null) continue;
    if (
      key === "ALLOW_INSECURE_DEV_MODE"
      || key === "DIAGNOSIS_GENERATION_THRESHOLD"
      || key === "DIAGNOSIS_MAX_WAIT_MS"
      || key === "LLM_MODE"
      || key === "LLM_PROVIDER"
      || key === "LLM_BRIDGE_URL"
      || key === "ANTHROPIC_API_KEY"
      || key === "NOTIFICATION_WEBHOOK_URL"
      || key === "CONSOLE_BASE_URL"
    ) {
      args.push("-e", `${key}=${value}`);
    }
  }

  process.stdout.write(`Starting 3am receiver on http://localhost:${port}\n`);
  process.stdout.write(`Image: ${image}\n`);
  args.push(image);

  const result = spawnSync("docker", args, { stdio: "inherit" });

  if (result.error) {
    process.stderr.write(`Error: failed to run Docker: ${result.error.message}\n`);
    process.exit(1);
    return;
  }

  if (result.status !== 0) {
    process.stderr.write(
      `Error: Docker image ${image} failed to start.\n\n` +
        "If you're a contributor with the 3am monorepo cloned:\n" +
        "  run `npx 3am local` from that repo to start the receiver from source.\n\n" +
        "Otherwise:\n" +
        "  ensure Docker is running and try again.\n" +
        "  See: https://github.com/muras3/3am#quick-start\n",
    );
    process.exit(result.status ?? 1);
  }
}
