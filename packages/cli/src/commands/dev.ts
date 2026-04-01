import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { loadCredentials } from "./init/credentials.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getCLIVersion(): string {
  try {
    // Resolve package.json relative to this file's location.
    // Works both from src/ (dev) and dist/commands/ (published):
    //   src/commands/dev.ts  → ../../package.json
    //   dist/commands/dev.js → ../../package.json
    const pkgPath = resolve(__dirname, "../../package.json");
    return JSON.parse(readFileSync(pkgPath, "utf-8")).version as string;
  } catch {
    // Fall back to a safe tag format that still follows the v-prefix convention.
    return "0.0.0-unknown";
  }
}

function resolveLocalRepoRoot(): string | null {
  const candidate = resolve(__dirname, "../../../../");
  const rootPackageJson = join(candidate, "package.json");
  const dockerfile = join(candidate, "Dockerfile");
  const receiverPackageJson = join(candidate, "apps", "receiver", "package.json");

  if (existsSync(rootPackageJson) && existsSync(dockerfile) && existsSync(receiverPackageJson)) {
    return candidate;
  }

  return null;
}

function buildLocalImage(repoRoot: string, image: string): void {
  process.stdout.write(`Building local receiver image from ${repoRoot}\n`);
  execSync(`docker build -t ${image} .`, {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

function isDockerInstalled(): boolean {
  try {
    execSync("docker --version", { stdio: "ignore" });
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

export function runDev(options: DevOptions = {}): void {
  if (!isDockerInstalled()) {
    process.stderr.write(
      "Error: Docker is a product prerequisite for local development.\n" +
        "Install Docker Desktop: https://www.docker.com/products/docker-desktop/\n",
    );
    process.exit(1);
    return;
  }

  const port = options.port ?? 3333;
  const version = getCLIVersion();
  const repoRoot = resolveLocalRepoRoot();
  const image = repoRoot
    ? "3amoncall-receiver:local"
    : `ghcr.io/3amoncall/receiver:v${version}`;

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

  const args = [
    "run",
    "--rm",
    "-p",
    `${port}:3000`,
    "-e",
    `ALLOW_INSECURE_DEV_MODE=true`,
    "-e",
    `DIAGNOSIS_GENERATION_THRESHOLD=0`,
    "-e",
    `DIAGNOSIS_MAX_WAIT_MS=0`,
  ];

  if (creds.llmMode) {
    args.push("-e", `LLM_MODE=${creds.llmMode}`);
  }
  if (creds.llmProvider) {
    args.push("-e", `LLM_PROVIDER=${creds.llmProvider}`);
  }
  if (creds.llmBridgeUrl) {
    args.push("-e", `LLM_BRIDGE_URL=${creds.llmBridgeUrl}`);
  }

  if (apiKey) {
    args.push("-e", `ANTHROPIC_API_KEY=${apiKey}`);
  }

  const webhookUrl = process.env["NOTIFICATION_WEBHOOK_URL"];
  if (webhookUrl) {
    args.push("-e", `NOTIFICATION_WEBHOOK_URL=${webhookUrl}`);
  }

  const consoleBaseUrl = process.env["CONSOLE_BASE_URL"];
  if (consoleBaseUrl) {
    args.push("-e", `CONSOLE_BASE_URL=${consoleBaseUrl}`);
  }

  process.stdout.write(`Starting 3amoncall receiver on http://localhost:${port}\n`);

  if (repoRoot) {
    try {
      buildLocalImage(repoRoot, image);
    } catch (error) {
      process.stderr.write(`Error: failed to build local receiver image: ${String(error)}\n`);
      process.exit(1);
      return;
    }
  } else {
    process.stdout.write(`Image: ${image}\n`);
  }

  args.push(image);

  const result = spawnSync("docker", args, { stdio: "inherit" });

  if (result.error) {
    process.stderr.write(`Error: failed to run Docker: ${result.error.message}\n`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
