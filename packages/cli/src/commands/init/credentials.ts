/**
 * Manage ANTHROPIC_API_KEY stored at ~/.config/3amoncall/credentials.
 *
 * - User-scoped, not project-scoped (same pattern as Sentry CLI, GitHub CLI)
 * - NOT in .env (it's a user credential, not a project dependency)
 * - File permission 0o600 (owner-only read/write)
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

export interface Credentials {
  anthropicApiKey?: string;
}

function getCredentialsDir(): string {
  return join(homedir(), ".config", "3amoncall");
}

function getCredentialsPath(): string {
  return join(getCredentialsDir(), "credentials");
}

export function loadCredentials(): Credentials {
  const path = getCredentialsPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Credentials;
  } catch {
    return {};
  }
}

export function saveCredentials(creds: Credentials): void {
  const dir = getCredentialsDir();
  mkdirSync(dir, { recursive: true });
  const path = getCredentialsPath();
  writeFileSync(path, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  // Ensure permissions even if file existed with different mode
  chmodSync(path, 0o600);
}

export async function promptApiKey(): Promise<string> {
  process.stdout.write("Enter your ANTHROPIC_API_KEY: ");

  // Non-TTY fallback (piped input in CI)
  if (!process.stdin.isTTY || typeof (process.stdin as NodeJS.ReadStream).setRawMode !== "function") {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      rl.question("", (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  const stdin = process.stdin as NodeJS.ReadStream;
  return new Promise((resolve) => {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";

    const onData = (ch: string) => {
      const code = ch.charCodeAt(0);

      if (code === 0x03) {
        // Ctrl+C
        process.stdout.write("\n");
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.exit(1);
      } else if (code === 0x0d || code === 0x0a) {
        // Enter
        process.stdout.write("\n");
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        resolve(value.trim());
      } else if (code === 0x7f || code === 0x08) {
        // Backspace
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else if (code >= 0x20) {
        // Printable character
        value += ch;
        process.stdout.write("*");
      }
    };

    stdin.on("data", onData);
  });
}

/**
 * Resolve the Anthropic API key from multiple sources.
 * Priority: --api-key flag > env var > stored credentials > interactive prompt.
 *
 * Returns the key or undefined if not available (non-interactive mode without key).
 */
export async function resolveApiKey(options: {
  apiKey?: string;
  noInteractive?: boolean;
}): Promise<string | undefined> {
  // 1. CLI flag
  if (options.apiKey) {
    saveCredentials({ anthropicApiKey: options.apiKey });
    return options.apiKey;
  }

  // 2. Environment variable
  const envKey = process.env["ANTHROPIC_API_KEY"];
  if (envKey) return envKey;

  // 3. Stored credentials
  const stored = loadCredentials();
  if (stored.anthropicApiKey) return stored.anthropicApiKey;

  // 4. Interactive prompt
  if (options.noInteractive) {
    return undefined;
  }

  const key = await promptApiKey();
  if (key) {
    saveCredentials({ anthropicApiKey: key });
    return key;
  }

  return undefined;
}
