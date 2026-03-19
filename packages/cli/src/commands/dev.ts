import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

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
  const image = `ghcr.io/3amoncall/receiver:v${version}`;

  const apiKey = process.env["ANTHROPIC_API_KEY"] ?? loadEnvApiKey(process.cwd());

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

  if (apiKey) {
    args.push("-e", `ANTHROPIC_API_KEY=${apiKey}`);
  }

  args.push(image);

  process.stdout.write(`Starting 3amoncall receiver on http://localhost:${port}\n`);
  process.stdout.write(`Image: ${image}\n`);

  const result = spawnSync("docker", args, { stdio: "inherit" });

  if (result.error) {
    process.stderr.write(`Error: failed to run Docker: ${result.error.message}\n`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
