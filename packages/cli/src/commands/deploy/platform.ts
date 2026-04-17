/**
 * Platform detection utilities for `npx 3am deploy`.
 *
 * Detects whether platform CLIs (vercel / wrangler) are installed and
 * authenticated, and prompts the user to select a target platform.
 *
 * - No npm dependencies — only Node built-ins
 * - All output via process.stdout.write / process.stderr.write
 * - Uses execFileSync / execFile (never exec) to avoid shell injection
 */
import { execFileSync, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type Platform = "vercel" | "cloudflare";

const CLI_BINARY: Record<Platform, string> = {
  vercel: "vercel",
  cloudflare: "wrangler",
};

/**
 * Checks whether the platform CLI binary is available on PATH.
 *
 * Uses `which <binary>` via execFileSync. Returns true if found, false if
 * the binary is not on PATH (execFileSync throws).
 *
 * NEVER uses `exec` (shell injection risk).
 */
export function detectPlatformCli(platform: Platform): boolean {
  const binary = CLI_BINARY[platform];
  try {
    execFileSync("which", [binary], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks whether the platform CLI is authenticated.
 *
 * Runs `<binary> whoami` and returns true if the process exits with code 0,
 * false otherwise. stdout/stderr are suppressed (captured, not displayed).
 *
 * For Cloudflare, CLOUDFLARE_API_TOKEN and CF_API_TOKEN are stripped from
 * the subprocess env so that wrangler uses OAuth credentials rather than a
 * scoped cfut_ token (which lacks /accounts access and causes a 9109 error).
 */
export async function checkPlatformAuth(platform: Platform): Promise<boolean> {
  const binary = CLI_BINARY[platform];
  try {
    let env: NodeJS.ProcessEnv | undefined;
    if (platform === "cloudflare") {
      // Strip CF API token env vars so wrangler whoami uses OAuth, not a
      // scoped token that may lack /accounts read access (code 9109).
      const { CLOUDFLARE_API_TOKEN: _a, CF_API_TOKEN: _b, ...rest } = process.env;
      env = rest;
    }
    await execFileAsync(binary, ["whoami"], { env });
    return true;
  } catch {
    return false;
  }
}

/**
 * Prompts the user to select a deployment platform interactively.
 *
 * Displays a numbered menu and returns the selected platform. Invalid input
 * causes the prompt to repeat until a valid selection is made.
 */
export async function promptPlatformSelection(): Promise<Platform> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    const ask = (): void => {
      process.stdout.write("Select platform:\n  [1] Vercel\n  [2] Cloudflare\n");
      rl.question("> ", (answer) => {
        const trimmed = answer.trim();
        if (trimmed === "1") {
          rl.close();
          resolve("vercel");
        } else if (trimmed === "2") {
          rl.close();
          resolve("cloudflare");
        } else {
          process.stdout.write("Invalid selection. Please enter 1 or 2.\n");
          ask();
        }
      });
    };
    ask();
  });
}
