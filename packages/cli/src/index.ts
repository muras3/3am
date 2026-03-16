#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { IncidentPacketSchema } from "@3amoncall/core";
import { diagnose } from "@3amoncall/diagnosis";

/**
 * Parse CLI arguments from an argv array (starting after the node/script args).
 * Usage: --packet <path> [--callback-url <url> --callback-token <token>]
 */
function parseArgs(argv: string[]): {
  packetPath: string | undefined;
  callbackUrl: string | undefined;
  callbackToken: string | undefined;
} {
  let packetPath: string | undefined;
  let callbackUrl: string | undefined;
  let callbackToken: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--packet" && argv[i + 1]) {
      packetPath = argv[++i];
    } else if (argv[i] === "--callback-url" && argv[i + 1]) {
      callbackUrl = argv[++i];
    } else if (argv[i] === "--callback-token" && argv[i + 1]) {
      callbackToken = argv[++i];
    }
  }

  return { packetPath, callbackUrl, callbackToken };
}

const RETRYABLE_STATUSES = new Set([429, 502, 503, 529]);
const MAX_RETRIES = 2; // 3 total attempts

/**
 * Wraps fetch with retry logic for transient errors.
 * Retries on network errors or retryable HTTP status codes (429, 502, 503, 529).
 * Non-retryable status codes (e.g. 400, 401) are returned as-is; caller checks response.ok.
 * Backoff: 1000 * 2^(attempt-1) ms (1s, 2s).
 */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown = new Error("fetchWithRetry: no attempts made");
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
    }
    try {
      const response = await fetch(url, init);
      if (!RETRYABLE_STATUSES.has(response.status)) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * Main CLI function. Exported for testability.
 * @param argv - argument array (e.g. process.argv.slice(2))
 */
export async function run(argv: string[]): Promise<void> {
  const { packetPath, callbackUrl, callbackToken } = parseArgs(argv);

  if (!packetPath) {
    process.stderr.write("Error: --packet <path> is required\n");
    process.exit(1);
    return;
  }

  // Step 1: Read and validate the packet
  let rawJson: string;
  try {
    rawJson = readFileSync(packetPath, "utf-8");
  } catch (err) {
    process.stderr.write(`Error: could not read file "${packetPath}": ${String(err)}\n`);
    process.exit(1);
    return;
  }

  let packetData: unknown;
  try {
    packetData = JSON.parse(rawJson);
  } catch {
    process.stderr.write(`Error: "${packetPath}" is not valid JSON\n`);
    process.exit(1);
    return;
  }

  const parseResult = IncidentPacketSchema.safeParse(packetData);
  if (!parseResult.success) {
    process.stderr.write(`Error: invalid IncidentPacket: ${parseResult.error.message}\n`);
    process.exit(1);
    return;
  }

  const packet = parseResult.data;

  // Step 2: Run diagnosis
  let result;
  try {
    result = await diagnose(packet);
  } catch (err) {
    process.stderr.write(`Error: diagnosis failed: ${String(err)}\n`);
    process.exit(1);
    return;
  }

  // Step 3 (optional): POST result to callback URL
  if (callbackUrl) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (callbackToken) {
      headers["Authorization"] = `Bearer ${callbackToken}`;
    }

    let response: Response;
    try {
      response = await fetchWithRetry(callbackUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(result),
      });
    } catch (err) {
      process.stderr.write(`Error: callback request failed after retries: ${String(err)}\n`);
      process.exit(1);
      return;
    }

    if (!response.ok) {
      process.stderr.write(
        `Error: callback returned HTTP ${response.status}\n`,
      );
      process.exit(1);
      return;
    }
  }

  // Step 4: Write result to stdout
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

// Only run when executed as the entry-point binary (not when imported by tests).
// Standard ESM pattern: compare import.meta.url (this module's URL) to process.argv[1].
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  run(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`Unexpected error: ${String(err)}\n`);
    process.exit(1);
  });
}
