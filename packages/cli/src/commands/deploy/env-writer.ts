/**
 * Write OTEL environment variables to the user's app `.env` file
 * after deploying the Receiver.
 *
 * - No npm dependencies — only Node built-ins (node:fs, node:path, node:readline)
 * - All output via process.stdout.write (never console.log)
 * - Preserves all existing lines, comments, and whitespace
 * - Updates keys in-place if they already exist; appends if absent
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const OTEL_ENDPOINT_KEY = "OTEL_EXPORTER_OTLP_ENDPOINT";
const OTEL_HEADERS_KEY = "OTEL_EXPORTER_OTLP_HEADERS";

export interface UpdateEnvOptions {
  receiverUrl: string;
  authToken: string;
  /** Defaults to path.join(process.cwd(), ".env") */
  envPath?: string;
  /** If true, return changes without writing the file */
  dryRun?: boolean;
}

export interface UpdateEnvResult {
  /** Keys that were added (didn't exist before) */
  added: string[];
  /** Keys that were updated (existed with a different value) */
  updated: string[];
  /** Absolute path of the .env file */
  envPath: string;
}

/**
 * Ensure a URL has the https:// prefix.
 * If the URL already starts with http:// or https://, leave it unchanged.
 * Otherwise prepend https://.
 */
function ensureHttps(url: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  return `https://${url}`;
}

/**
 * Update (or create) the `.env` file at `envPath` with the two OTEL keys
 * required for the app to send telemetry to the deployed Receiver.
 *
 * Preserves all existing lines, comments, and whitespace.
 * Keys that already exist with the same value are left unchanged.
 */
export function updateAppEnv(options: UpdateEnvOptions): UpdateEnvResult {
  const envPath = resolve(options.envPath ?? ".env");
  const endpointValue = ensureHttps(options.receiverUrl);
  const headersValue = `Authorization=Bearer ${options.authToken}`;

  const targets: Record<string, string> = {
    [OTEL_ENDPOINT_KEY]: endpointValue,
    [OTEL_HEADERS_KEY]: headersValue,
  };

  // Read existing content (or empty string if file doesn't exist)
  const existing = existsSync(envPath)
    ? readFileSync(envPath, "utf-8")
    : "";

  const lines = existing.split("\n");

  const added: string[] = [];
  const updated: string[] = [];

  // Track which target keys we've already processed (found in existing lines)
  const processed = new Set<string>();

  // Pass 1: update existing lines in-place
  const newLines = lines.map((line) => {
    // Match KEY=VALUE lines (allow optional whitespace around =)
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match) return line;

    const key = match[1]!;
    if (!(key in targets)) return line;

    const desiredValue = targets[key]!;
    processed.add(key);

    if (match[2] === desiredValue) {
      // Same value — no change
      return line;
    }

    // Different value — update in place
    updated.push(key);
    return `${key}=${desiredValue}`;
  });

  // Pass 2: append keys that were not found
  for (const key of Object.keys(targets)) {
    if (!processed.has(key)) {
      added.push(key);
      // Ensure the file ends with a newline before appending
      const last = newLines[newLines.length - 1];
      if (last !== undefined && last !== "") {
        newLines.push("");
      }
      newLines.push(`${key}=${targets[key]}`);
    }
  }

  if (!options.dryRun) {
    writeFileSync(envPath, newLines.join("\n"), "utf-8");
  }

  return { added, updated, envPath };
}

/**
 * Interactively prompt the user for the AUTH_TOKEN.
 * Re-prompts if the user submits an empty string.
 */
export async function promptAuthToken(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    const ask = () => {
      rl.question(
        "Enter AUTH_TOKEN (from Console first-access screen): ",
        (answer) => {
          const token = answer.trim();
          if (!token) {
            ask();
            return;
          }
          rl.close();
          resolve(token);
        },
      );
    };
    ask();
  });
}
