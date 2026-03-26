/**
 * Deploy executor for `npx 3amoncall deploy`.
 *
 * Wraps `vercel deploy --prod` / `wrangler deploy` via spawn, tees stdout to
 * the terminal while capturing it for URL extraction, then returns the
 * deployment URL.
 *
 * - NEVER uses exec (shell injection risk) — only spawn
 * - No npm dependencies — only Node built-ins
 * - All output via process.stdout.write / process.stderr.write
 * - stdin: inherit (in case platform CLI needs input)
 * - stderr: inherit (goes directly to terminal)
 * - stdout: pipe (captured + tee'd to process.stdout)
 */
import { spawn } from "node:child_process";

export type Platform = "vercel" | "cloudflare";

const PLATFORM_COMMAND: Record<Platform, { cmd: string; args: string[] }> = {
  vercel: { cmd: "vercel", args: ["deploy", "--prod"] },
  cloudflare: { cmd: "wrangler", args: ["deploy"] },
};

/**
 * Extract the deployment URL from captured stdout.
 *
 * Vercel: looks for `https://` URL ending in `.vercel.app`
 * Cloudflare: looks for URL in `Published ... (https://...workers.dev)` pattern
 */
function extractUrl(platform: Platform, output: string): string | undefined {
  if (platform === "vercel") {
    const match = output.match(/https:\/\/[^\s]+\.vercel\.app/);
    return match?.[0];
  }

  if (platform === "cloudflare") {
    const match = output.match(/Published[^\n]*\(https:\/\/[^\s)]+\)/);
    if (match) {
      const urlMatch = match[0].match(/\(https:\/\/[^\s)]+\)/);
      if (urlMatch) {
        return urlMatch[0].slice(1, -1); // strip surrounding parens
      }
    }
    return undefined;
  }

  return undefined;
}

/**
 * Runs the platform-specific deploy command, tees stdout to the terminal,
 * and returns the extracted deployment URL.
 *
 * @throws Error with exit code if the process exits non-zero
 * @throws Error with descriptive message if no URL is found in stdout
 */
export function runPlatformDeploy(
  platform: Platform,
): Promise<{ url: string }> {
  return new Promise((resolve, reject) => {
    const { cmd, args } = PLATFORM_COMMAND[platform];

    const child = spawn(cmd, args, {
      stdio: ["inherit", "pipe", "inherit"],
    });

    const chunks: Buffer[] = [];

    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        process.stdout.write(chunk);
      });
    }

    child.on("close", (code: number | null) => {
      if (code !== 0) {
        reject(new Error(`Deploy process exited with code ${code ?? "null"}`));
        return;
      }

      const output = Buffer.concat(chunks).toString("utf8");
      const url = extractUrl(platform, output);

      if (!url) {
        reject(
          new Error(
            `Deploy succeeded but no deployment URL was found in output.\n` +
              `Platform: ${platform}\n` +
              `Output:\n${output}`,
          ),
        );
        return;
      }

      resolve({ url });
    });
  });
}
