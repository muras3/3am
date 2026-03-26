/**
 * DeployProvider — platform-abstracted Receiver deployment.
 *
 * The Receiver code lives in the 3amoncall repo, NOT in the user's cwd.
 * Each provider clones the repo to a temp directory, provisions the platform
 * project, sets env vars, and deploys from there.
 *
 * - Vercel: git clone → vercel deploy --prod --yes
 * - Cloudflare: git clone → wrangler deploy
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

const REPO_URL = "https://github.com/3amoncall/3amoncall.git";

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

// ---------------------------------------------------------------------------
// Vercel
// ---------------------------------------------------------------------------

function extractVercelUrl(output: string): string | undefined {
  // Vercel prints the production URL, e.g. https://my-project.vercel.app
  const match = output.match(/https:\/\/[^\s]+\.vercel\.app/);
  return match?.[0];
}

export function createVercelProvider(): DeployProvider {
  let tempDir: string | undefined;

  return {
    async deploy() {
      tempDir = cloneReceiver();
      process.stderr.write(`Cloned Receiver to ${tempDir}\n`);

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
      if (!tempDir) throw new Error("deploy() must be called before setEnvVar()");
      // vercel env add reads value from stdin
      const child = spawn("vercel", ["env", "add", key, "production", "--yes"], {
        cwd: tempDir,
        stdio: ["pipe", "pipe", "inherit"],
      });
      child.stdin!.write(value);
      child.stdin!.end();

      await new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => {
          if (code !== 0) {
            reject(new Error(`vercel env add ${key} exited with code ${code}`));
          } else {
            resolve();
          }
        });
      });
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
  const match = output.match(/Published[^\n]*\(https:\/\/[^\s)]+\)/);
  if (match) {
    const urlMatch = match[0].match(/\(https:\/\/[^\s)]+\)/);
    if (urlMatch) {
      return urlMatch[0].slice(1, -1);
    }
  }
  return undefined;
}

export function createCloudflareProvider(): DeployProvider {
  let tempDir: string | undefined;

  return {
    async deploy() {
      tempDir = cloneReceiver();
      process.stderr.write(`Cloned Receiver to ${tempDir}\n`);

      const result = await spawnAndCapture(
        "wrangler",
        ["deploy"],
        tempDir,
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
      if (!tempDir) throw new Error("deploy() must be called before setEnvVar()");
      // wrangler secret put reads value from stdin
      const child = spawn("wrangler", ["secret", "put", key], {
        cwd: tempDir,
        stdio: ["pipe", "pipe", "inherit"],
      });
      child.stdin!.write(value);
      child.stdin!.end();

      await new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => {
          if (code !== 0) {
            reject(new Error(`wrangler secret put ${key} exited with code ${code}`));
          } else {
            resolve();
          }
        });
      });
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
