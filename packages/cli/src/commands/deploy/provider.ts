/**
 * DeployProvider — platform-abstracted Receiver deployment.
 *
 * The Receiver code lives in the 3amoncall repo, NOT in the user's cwd.
 * Each provider clones the repo to a temp directory, provisions the platform
 * project, sets env vars, and deploys from there.
 *
 * Vercel flow:
 *   git clone → vercel link --yes → vercel env add → vercel deploy --prod --yes
 *   (Vercel handles pnpm install + build via vercel.json)
 *
 * Cloudflare flow:
 *   git clone → pnpm install → pnpm turbo build (Console assets) →
 *   wrangler d1 create → patch wrangler.toml → wrangler secret put →
 *   wrangler deploy
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface DeployProvider {
  /** Clone Receiver repo and deploy to platform. Returns deployment URL. */
  deploy(): Promise<{ url: string }>;
  /** Set an environment variable / secret on the deployed project. */
  setEnvVar(key: string, value: string): Promise<void>;
  /** Clean up temp directory. */
  cleanup(): void;
}

const REPO_URL = "https://github.com/muras3/3amoncall.git";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function cloneReceiver(): string {
  const dir = mkdtempSync(join(tmpdir(), "3amoncall-deploy-"));
  execFileSync("git", ["clone", "--depth", "1", "--single-branch", REPO_URL, dir], {
    stdio: "pipe",
  });
  return dir;
}

/**
 * Spawn a command, tee stdout to the terminal, and return captured stdout.
 */
function spawnAndCapture(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["inherit", "pipe", "inherit"],
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
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["pipe", "pipe", "inherit"],
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

// ---------------------------------------------------------------------------
// Vercel
// ---------------------------------------------------------------------------

function extractVercelUrl(output: string): string | undefined {
  // Vercel prints the production URL, e.g. https://my-project.vercel.app
  const match = output.match(/https:\/\/[^\s]+\.vercel\.app/);
  return match?.[0];
}

export function createVercelProvider(): DeployProvider {
  let tempDir: string | undefined = cloneReceiver();
  process.stderr.write(`Cloned Receiver to ${tempDir}\n`);

  // Create Vercel project link so env vars can be set before deploy.
  // --yes auto-confirms org selection and new project creation.
  process.stderr.write("Linking Vercel project...\n");
  execFileSync("vercel", ["link", "--yes"], {
    cwd: tempDir,
    stdio: "inherit",
  });

  return {
    async deploy() {
      if (!tempDir) throw new Error("cleanup() was already called");

      const result = await spawnAndCapture(
        "vercel",
        ["deploy", "--prod", "--yes"],
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

      return { url };
    },

    async setEnvVar(key, value) {
      if (!tempDir) throw new Error("cleanup() was already called");
      await spawnWithStdin(
        "vercel",
        ["env", "add", key, "production", "--yes"],
        tempDir,
        value,
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
 * Create a D1 database and return its UUID.
 * `wrangler d1 create <name>` outputs something like:
 *   ✅ Successfully created DB '<name>'
 *   ...
 *   database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
 */
function createD1Database(name: string, cwd: string): string {
  const output = execFileSync("wrangler", ["d1", "create", name], {
    cwd,
    stdio: "pipe",
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

export function createCloudflareProvider(): DeployProvider {
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
  execFileSync("pnpm", ["turbo", "run", "build", "--filter=@3amoncall/console..."], {
    cwd: tempDir,
    stdio: "inherit",
  });

  // Create a fresh D1 database for this deployment
  process.stderr.write("Creating D1 database...\n");
  const dbId = createD1Database("3amoncall-db", receiverDir);
  patchWranglerToml(receiverDir, dbId);
  process.stderr.write(`D1 database created: ${dbId}\n`);

  return {
    async deploy() {
      if (!tempDir) throw new Error("cleanup() was already called");

      const result = await spawnAndCapture(
        "wrangler",
        ["deploy"],
        receiverDir,
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

export function createProvider(platform: "vercel" | "cloudflare"): DeployProvider {
  if (platform === "vercel") return createVercelProvider();
  return createCloudflareProvider();
}
