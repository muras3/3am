/**
 * Manage ANTHROPIC_API_KEY stored at ~/.config/3am/credentials.
 *
 * - User-scoped, not project-scoped (same pattern as Sentry CLI, GitHub CLI)
 * - NOT in .env (it's a user credential, not a project dependency)
 * - File permission 0o600 (owner-only read/write)
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import type { ProviderName } from "3am-diagnosis";

export type DiagnosisMode = "automatic" | "manual";
export type ReceiverPlatform = "vercel" | "cloudflare";

export interface ReceiverCredential {
  url: string;
  authToken: string;
  updatedAt: string;
}

export interface Credentials {
  anthropicApiKey?: string;
  locale?: string;
  llmMode?: DiagnosisMode;
  llmProvider?: ProviderName;
  llmBridgeUrl?: string;
  llmModel?: string;
  /** Last deployed Receiver URL managed by the CLI. */
  receiverUrl?: string;
  /** Auth token for the deployed Receiver — CLI-managed, synced to platform secret on deploy. */
  receiverAuthToken?: string;
  /** Platform-scoped receiver credentials for multi-platform deploys. */
  receivers?: Partial<Record<ReceiverPlatform, ReceiverCredential>>;
}

function getCredentialsDir(): string {
  return join(homedir(), ".config", "3am");
}

function getCredentialsPath(): string {
  return join(getCredentialsDir(), "credentials");
}

/**
 * Canonicalize a receiver URL for consistent matching.
 *
 * Normalizations applied:
 * - lowercase scheme + host
 * - strip default port (:80 for http, :443 for https)
 * - strip trailing slashes from path
 * - preserve non-default ports and paths
 *
 * Returns the original string if URL parsing fails, so callers remain safe.
 */
export function canonicalizeReceiverUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // lowercase scheme and host are already normalized by URL constructor
    // strip default ports
    if (
      (parsed.protocol === "https:" && parsed.port === "443") ||
      (parsed.protocol === "http:" && parsed.port === "80")
    ) {
      parsed.port = "";
    }
    // strip trailing slashes from pathname
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString();
  } catch {
    return url;
  }
}

function inferPlatformFromReceiverUrl(url: string | undefined): ReceiverPlatform | undefined {
  if (!url) return undefined;
  try {
    const hostname = new URL(url).hostname;
    if (hostname.includes("workers.dev")) return "cloudflare";
    if (hostname.includes("vercel.app")) return "vercel";
  } catch {
    return undefined;
  }
  return undefined;
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

export function getReceiverCredential(
  creds: Credentials,
  platform: ReceiverPlatform,
): ReceiverCredential | undefined {
  const scoped = creds.receivers?.[platform];
  if (scoped?.url && scoped.authToken) return scoped;

  if (
    creds.receiverUrl &&
    creds.receiverAuthToken &&
    inferPlatformFromReceiverUrl(creds.receiverUrl) === platform
  ) {
    return {
      url: creds.receiverUrl,
      authToken: creds.receiverAuthToken,
      updatedAt: new Date(0).toISOString(),
    };
  }

  return undefined;
}

export function setReceiverCredential(
  creds: Credentials,
  platform: ReceiverPlatform,
  receiver: { url: string; authToken: string },
): Credentials {
  // Store URL as-is (no format change for backward compatibility).
  // canonicalizeReceiverUrl is applied only at lookup time.
  return {
    ...creds,
    receiverUrl: receiver.url,
    receiverAuthToken: receiver.authToken,
    receivers: {
      ...(creds.receivers ?? {}),
      [platform]: {
        url: receiver.url,
        authToken: receiver.authToken,
        updatedAt: new Date().toISOString(),
      },
    },
  };
}

export function findReceiverCredentialByUrl(
  creds: Credentials,
  url: string,
): ReceiverCredential | undefined {
  const needle = canonicalizeReceiverUrl(url);

  for (const receiver of Object.values(creds.receivers ?? {})) {
    if (receiver?.authToken && canonicalizeReceiverUrl(receiver.url) === needle) {
      return receiver;
    }
  }

  if (creds.receiverUrl && creds.receiverAuthToken &&
      canonicalizeReceiverUrl(creds.receiverUrl) === needle) {
    return {
      url: creds.receiverUrl,
      authToken: creds.receiverAuthToken,
      updatedAt: new Date(0).toISOString(),
    };
  }

  return undefined;
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
    const existing = loadCredentials();
    saveCredentials({ ...existing, anthropicApiKey: options.apiKey });
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
    const existing = loadCredentials();
    saveCredentials({ ...existing, anthropicApiKey: key });
    return key;
  }

  return undefined;
}
