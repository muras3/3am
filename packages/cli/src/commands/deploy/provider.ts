/**
 * DeployProvider — platform-abstracted Receiver deployment.
 *
 * The Receiver code lives in the 3am repo, NOT in the user's cwd.
 * Each provider clones the repo to a temp directory, provisions the platform
 * project, sets env vars, and deploys from there.
 *
 * Vercel flow:
 *   git clone → vercel link --yes → vercel env add → vercel deploy --prod --yes
 *   (Vercel handles pnpm install + build via vercel.json)
 *
 * Cloudflare flow:
 *   git clone → pnpm install → pnpm turbo build (Console assets) →
 *   wrangler d1 create → wrangler queues create → patch wrangler.toml → wrangler secret put →
 *   wrangler deploy
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { getCloudflareAccountInfo } from "../cloudflare-workers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface DeployProvider {
  /** Clone Receiver repo and deploy to platform. Returns deployment URL. */
  deploy(): Promise<{ url: string }>;
  /** Set an environment variable / secret on the deployed project. */
  setEnvVar(key: string, value: string): Promise<void>;
  /** Clean up temp directory. */
  cleanup(): void;
}

export interface ProviderOptions {
  projectName?: string;
  /** Cloudflare account ID override (required for scoped CF API tokens that lack Account:Read) */
  accountId?: string;
}

const REPO_URL = "https://github.com/muras3/3am.git";
const CLOUDFLARE_DIAGNOSIS_QUEUE = "3am-diagnosis";
const CLOUDFLARE_DIAGNOSIS_DLQ = "3am-diagnosis-dlq";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function getCLIVersion(): string {
  try {
    const pkgPath = resolve(__dirname, "../../package.json");
    return JSON.parse(readFileSync(pkgPath, "utf-8")).version as string;
  } catch {
    return "0.0.0-unknown";
  }
}

function cloneReceiver(): string {
  const dir = mkdtempSync(join(tmpdir(), "3am-deploy-"));
  const repoSource = process.env["THREEAM_DEPLOY_REPO"] ?? REPO_URL;
  const version = getCLIVersion();
  const tag = `v${version}`;

  if (repoSource.startsWith("http") && !version.includes("unknown")) {
    // Pin to the release tag matching this CLI version
    try {
      execFileSync("git", ["clone", "--depth", "1", "--branch", tag, repoSource, dir], {
        stdio: "pipe",
      });
      return dir;
    } catch {
      // Tag doesn't exist (dev/pre-release) — fall back to default branch
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const fallbackDir = mkdtempSync(join(tmpdir(), "3am-deploy-"));
  const cloneArgs = repoSource.startsWith("http")
    ? ["clone", "--depth", "1", "--single-branch", repoSource, fallbackDir]
    : ["clone", repoSource, fallbackDir];
  execFileSync("git", cloneArgs, {
    stdio: "pipe",
  });
  return fallbackDir;
}

/**
 * Spawn a command, tee stdout to the terminal, and return captured stdout.
 */
function spawnAndCapture(
  cmd: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["inherit", "pipe", "inherit"],
      ...(env ? { env } : {}),
    });

    const chunks: Buffer[] = [];

    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        process.stdout.write(chunk);
      });
    }

    child.on("error", reject);
    child.on("close", (code: number | null) => {
      resolve({
        stdout: Buffer.concat(chunks).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
  });
}

/**
 * Spawn a command that reads a value from stdin (for env var / secret setting).
 */
function spawnWithStdin(
  cmd: string,
  args: string[],
  cwd: string,
  stdinValue: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["pipe", "pipe", "inherit"],
      ...(env ? { env } : {}),
    });
    child.stdin!.write(stdinValue);
    child.stdin!.end();
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
}

function listVercelEnvKeys(cwd: string, environment = "production"): string[] {
  const output = execFileSync(
    "vercel",
    ["env", "ls", environment, "--format", "json"],
    { cwd, stdio: "pipe" },
  ).toString();

  try {
    const parsed = JSON.parse(output) as { envs?: Array<{ key?: string }> };
    return (parsed.envs ?? []).flatMap((env) =>
      typeof env.key === "string" ? [env.key] : [],
    );
  } catch {
    return [];
  }
}

function hasExistingVercelDatabaseEnv(cwd: string): boolean {
  const envKeys = new Set(listVercelEnvKeys(cwd));
  return envKeys.has("DATABASE_URL") || envKeys.has("POSTGRES_URL");
}

// ---------------------------------------------------------------------------
// Vercel
// ---------------------------------------------------------------------------

function extractVercelUrl(output: string): string | undefined {
  // Vercel prints the production URL, e.g. https://my-project.vercel.app
  const match = output.match(/https:\/\/[^\s]+\.vercel\.app/);
  return match?.[0];
}

function normalizeUrlCandidate(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function collectUrlStrings(value: unknown, urls: Set<string>): void {
  if (typeof value === "string") {
    const normalized = normalizeUrlCandidate(value);
    if (normalized) {
      urls.add(normalized);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectUrlStrings(item, urls);
    }
    return;
  }

  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) {
      collectUrlStrings(nested, urls);
    }
  }
}

function readLinkedVercelProjectName(cwd: string): string | undefined {
  const projectPath = join(cwd, ".vercel", "project.json");
  if (!existsSync(projectPath)) return undefined;

  try {
    const raw = readFileSync(projectPath, "utf-8");
    const parsed = JSON.parse(raw) as { projectName?: string; name?: string };
    const projectName = parsed.projectName ?? parsed.name;
    return typeof projectName === "string" && projectName.trim().length > 0
      ? projectName.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

export function resolveVercelProductionUrl(cwd: string, deploymentUrl: string): string {
  const normalizedDeploymentUrl = normalizeUrlCandidate(deploymentUrl) ?? deploymentUrl;
  const linkedProjectName = readLinkedVercelProjectName(cwd);

  try {
    const raw = execFileSync(
      "vercel",
      ["inspect", deploymentUrl, "--format=json"],
      { cwd, stdio: "pipe" },
    ).toString();
    const parsed = JSON.parse(raw) as unknown;
    const collected = new Set<string>();
    collectUrlStrings(parsed, collected);

    const candidates = [...collected].filter((url) => {
      try {
        return new URL(url).hostname !== new URL(normalizedDeploymentUrl).hostname;
      } catch {
        return false;
      }
    });

    const vercelAliases = candidates.filter((url) => url.endsWith(".vercel.app"));
    const preferred = (vercelAliases.length > 0 ? vercelAliases : candidates)
      .sort((a, b) => a.length - b.length)[0];

    if (preferred) {
      return preferred;
    }
  } catch {
    // Fall through to linked-project fallback below.
  }

  if (linkedProjectName) {
    return `https://${linkedProjectName}.vercel.app`;
  }

  return normalizedDeploymentUrl;
}

export function createVercelProvider(options: ProviderOptions = {}): DeployProvider {
  let tempDir: string | undefined = cloneReceiver();
  const projectName = options.projectName ?? "3am-receiver";
  process.stderr.write(`Cloned Receiver to ${tempDir}\n`);

  // Create Vercel project link so env vars can be set before deploy.
  // --yes auto-confirms org selection and new project creation.
  // --project ensures a valid lowercase name (temp dir basenames can
  // contain uppercase characters which Vercel rejects).
  process.stderr.write("Linking Vercel project...\n");
  execFileSync("vercel", ["link", "--yes", "--project", projectName], {
    cwd: tempDir,
    stdio: "inherit",
  });

  if (hasExistingVercelDatabaseEnv(tempDir)) {
    process.stderr.write("Existing Postgres env detected — reusing current Vercel database.\n");
  } else {
    // Provision Neon Postgres (Vercel Marketplace).
    // --non-interactive skips all prompts including terms acceptance.
    // Running from a linked project auto-connects the resource and
    // injects DATABASE_URL into the project's env vars.
    process.stderr.write("Provisioning Neon Postgres database...\n");
    execFileSync("vercel", ["integration", "add", "neon", "--non-interactive"], {
      cwd: tempDir,
      stdio: "inherit",
    });
  }

  return {
    async deploy() {
      if (!tempDir) throw new Error("cleanup() was already called");

      const result = await spawnAndCapture(
        "vercel",
        ["deploy", "--prod", "--yes", "--archive", "tgz"],
        tempDir,
      );

      if (result.exitCode !== 0) {
        throw new Error(`vercel deploy exited with code ${result.exitCode}`);
      }

      const url = extractVercelUrl(result.stdout);
      if (!url) {
        throw new Error(
          "Deploy succeeded but no Vercel URL found in output.\n" +
            `Output:\n${result.stdout}`,
        );
      }

      return { url: resolveVercelProductionUrl(tempDir, url) };
    },

    async setEnvVar(key, value) {
      if (!tempDir) throw new Error("cleanup() was already called");
      execFileSync(
        "vercel",
        ["env", "add", key, "production", "--value", value, "--yes", "--force"],
        { cwd: tempDir, stdio: "inherit" },
      );
    },

    cleanup() {
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
        tempDir = undefined;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Cloudflare
// ---------------------------------------------------------------------------

function extractWranglerUrl(output: string): string | undefined {
  // wrangler 4.x: "  https://<name>.<subdomain>.workers.dev"
  const match = output.match(/https:\/\/[^\s]+\.workers\.dev/);
  return match?.[0];
}

/**
 * Find an existing D1 database by name, or return undefined.
 * `wrangler d1 list` outputs TOML-like blocks per database.
 */
function findD1Database(name: string, cwd: string, env?: NodeJS.ProcessEnv): string | undefined {
  const output = execFileSync("wrangler", ["d1", "list"], {
    cwd,
    stdio: "pipe",
    ...(env ? { env } : {}),
  }).toString();

  // Match the line with our database name and extract the UUID from the same row.
  // wrangler d1 list output is a table with columns: uuid, name, created_at, ...
  for (const line of output.split("\n")) {
    if (line.includes(name)) {
      const uuidMatch = line.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
      if (uuidMatch) return uuidMatch[0];
    }
  }
  return undefined;
}

/**
 * Create a D1 database and return its UUID.
 * `wrangler d1 create <name>` outputs something like:
 *   ✅ Successfully created DB '<name>'
 *   ...
 *   database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
 */
function createD1Database(name: string, cwd: string, env?: NodeJS.ProcessEnv): string {
  const output = execFileSync("wrangler", ["d1", "create", name], {
    cwd,
    stdio: "pipe",
    ...(env ? { env } : {}),
  }).toString();

  const match = output.match(/database_id\s*=\s*"([0-9a-f-]+)"/);
  if (!match?.[1]) {
    throw new Error(
      `Failed to parse D1 database_id from wrangler output.\nOutput:\n${output}`,
    );
  }
  return match[1];
}

/**
 * Get or create a D1 database. Reuses existing if found by name.
 */
function ensureD1Database(name: string, cwd: string, env?: NodeJS.ProcessEnv): string {
  const existing = findD1Database(name, cwd, env);
  if (existing) {
    process.stderr.write(`Reusing existing D1 database: ${existing}\n`);
    return existing;
  }
  return createD1Database(name, cwd, env);
}

/**
 * Replace the hardcoded database_id in wrangler.toml with the newly created one.
 */
function patchWranglerToml(receiverDir: string, newDbId: string): void {
  const tomlPath = join(receiverDir, "wrangler.toml");
  const content = readFileSync(tomlPath, "utf8");
  const patched = content.replace(
    /database_id\s*=\s*"[^"]*"/,
    `database_id = "${newDbId}"`,
  );
  writeFileSync(tomlPath, patched, "utf8");
}

function ensureQueue(name: string, cwd: string, env?: NodeJS.ProcessEnv): void {
  try {
    execFileSync("wrangler", ["queues", "create", name], {
      cwd,
      stdio: "pipe",
      ...(env ? { env } : {}),
    });
  } catch (error) {
    const output = [
      error instanceof Error ? error.message : String(error),
      typeof error === "object" && error && "stderr" in error
        ? String((error as { stderr?: Buffer }).stderr ?? "")
        : "",
    ].join("\n");
    const lower = output.toLowerCase();
    if (!lower.includes("already exists") && !lower.includes("already taken")) {
      throw error;
    }
    process.stderr.write(`Reusing existing Queue: ${name}\n`);
  }
}

export function createCloudflareProvider(options: ProviderOptions = {}): DeployProvider {
  // Resolve account ID from the user's cwd (where OAuth cache exists) BEFORE
  // switching to the temp directory.  Passing CLOUDFLARE_ACCOUNT_ID to every
  // wrangler invocation tells wrangler which account to use, avoiding the
  // /memberships API call that fails with scoped API tokens.
  // getCloudflareAccountInfo() honours explicit arg > CLOUDFLARE_ACCOUNT_ID env > CF_ACCOUNT_ID env > wrangler whoami.
  const { accountId } = getCloudflareAccountInfo(options.accountId);
  // Strip CLOUDFLARE_API_TOKEN and CF_API_TOKEN from the wrangler subprocess
  // environment.  cfut_ (User API Token / scoped token) tokens issued for
  // Observability:Edit lack D1:Edit and Queues:Edit, so forwarding them to
  // wrangler causes 403/9109 errors on d1 list/create and queues create.
  // The OAuth session on the host machine has the necessary permissions.
  const { CLOUDFLARE_API_TOKEN: _a, CF_API_TOKEN: _b, ...baseEnv } = process.env;
  const wranglerEnv: NodeJS.ProcessEnv = { ...baseEnv, CLOUDFLARE_ACCOUNT_ID: accountId };

  let tempDir: string | undefined = cloneReceiver();
  const receiverDir = join(tempDir, "apps", "receiver");
  process.stderr.write(`Cloned Receiver to ${tempDir}\n`);

  // Install dependencies (needed for wrangler bundling + console build)
  process.stderr.write("Installing dependencies...\n");
  execFileSync("pnpm", ["install", "--frozen-lockfile"], {
    cwd: tempDir,
    stdio: "inherit",
  });

  // Build Console (static assets referenced by wrangler.toml [assets])
  process.stderr.write("Building Console...\n");
  execFileSync("pnpm", ["turbo", "run", "build", "--filter=@3am/console..."], {
    cwd: tempDir,
    stdio: "inherit",
  });

  // Get or create D1 database (reuses existing on re-deploy)
  process.stderr.write("Provisioning D1 database...\n");
  const dbId = ensureD1Database("3am-db", receiverDir, wranglerEnv);
  patchWranglerToml(receiverDir, dbId);
  process.stderr.write(`D1 database ready: ${dbId}\n`);

  process.stderr.write("Provisioning Cloudflare Queues...\n");
  ensureQueue(CLOUDFLARE_DIAGNOSIS_DLQ, receiverDir, wranglerEnv);
  ensureQueue(CLOUDFLARE_DIAGNOSIS_QUEUE, receiverDir, wranglerEnv);

  return {
    async deploy() {
      if (!tempDir) throw new Error("cleanup() was already called");

      const result = await spawnAndCapture(
        "wrangler",
        ["deploy"],
        receiverDir,
        wranglerEnv,
      );

      if (result.exitCode !== 0) {
        throw new Error(`wrangler deploy exited with code ${result.exitCode}`);
      }

      const url = extractWranglerUrl(result.stdout);
      if (!url) {
        throw new Error(
          "Deploy succeeded but no Cloudflare URL found in output.\n" +
            `Output:\n${result.stdout}`,
        );
      }

      return { url };
    },

    async setEnvVar(key, value) {
      if (!tempDir) throw new Error("cleanup() was already called");
      await spawnWithStdin(
        "wrangler",
        ["secret", "put", key],
        receiverDir,
        value,
        wranglerEnv,
      );
    },

    cleanup() {
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
        tempDir = undefined;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createProvider(
  platform: "vercel" | "cloudflare",
  options: ProviderOptions = {},
): DeployProvider {
  if (platform === "vercel") return createVercelProvider(options);
  return createCloudflareProvider(options);
}
