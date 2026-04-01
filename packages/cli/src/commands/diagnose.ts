import { readFileSync } from "node:fs";
import { IncidentPacketSchema } from "@3amoncall/core";
import { PROVIDER_NAMES, diagnose, type ProviderName } from "@3amoncall/diagnosis";
import { loadCredentials } from "./init/credentials.js";
import { runManualDiagnosis } from "./manual-execution.js";

const RETRYABLE_STATUSES = new Set([429, 502, 503, 529]);
const MAX_RETRIES = 2;

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

function parseArgs(argv: string[]): {
  packetPath: string | undefined;
  callbackUrl: string | undefined;
  callbackToken: string | undefined;
  provider: string | undefined;
  model: string | undefined;
  incidentId: string | undefined;
  receiverUrl: string | undefined;
  authToken: string | undefined;
} {
  let packetPath: string | undefined;
  let callbackUrl: string | undefined;
  let callbackToken: string | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let incidentId: string | undefined;
  let receiverUrl: string | undefined;
  let authToken: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--packet" && argv[i + 1]) {
      packetPath = argv[++i];
    } else if (argv[i] === "--callback-url" && argv[i + 1]) {
      callbackUrl = argv[++i];
    } else if (argv[i] === "--callback-token" && argv[i + 1]) {
      callbackToken = argv[++i];
    } else if (argv[i] === "--provider" && argv[i + 1]) {
      provider = argv[++i];
    } else if (argv[i] === "--model" && argv[i + 1]) {
      model = argv[++i];
    } else if (argv[i] === "--incident-id" && argv[i + 1]) {
      incidentId = argv[++i];
    } else if (argv[i] === "--receiver-url" && argv[i + 1]) {
      receiverUrl = argv[++i];
    } else if (argv[i] === "--auth-token" && argv[i + 1]) {
      authToken = argv[++i];
    }
  }

  return { packetPath, callbackUrl, callbackToken, provider, model, incidentId, receiverUrl, authToken };
}

function parseProvider(value: string | undefined, fallback?: ProviderName): ProviderName | undefined {
  if ((PROVIDER_NAMES as readonly string[]).includes(value ?? "")) {
    return value as ProviderName;
  }
  return fallback;
}

export async function runDiagnose(argv: string[]): Promise<void> {
  const { packetPath, callbackUrl, callbackToken, provider, model, incidentId, receiverUrl, authToken } = parseArgs(argv);
  const creds = loadCredentials();

  if (incidentId && receiverUrl) {
    try {
      const result = await runManualDiagnosis({
        incidentId,
        receiverUrl,
        authToken,
        provider: parseProvider(provider, creds.llmProvider),
        model: model ?? creds.llmModel,
        locale: creds.locale === "ja" ? "ja" : "en",
      });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    } catch (err) {
      process.stderr.write(`Error: diagnosis failed: ${String(err)}\n`);
      process.exit(1);
      return;
    }
  }

  if (!packetPath) {
    process.stderr.write("Error: provide --packet <path> or (--incident-id <id> --receiver-url <url>)\n");
    process.exit(1);
    return;
  }

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

  let result;
  try {
    result = await diagnose(packet, {
      provider: parseProvider(provider, creds.llmProvider),
      model: model ?? creds.llmModel,
      locale: creds.locale === "ja" ? "ja" : "en",
    });
  } catch (err) {
    process.stderr.write(`Error: diagnosis failed: ${String(err)}\n`);
    process.exit(1);
    return;
  }

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
      process.stderr.write(`Error: callback returned HTTP ${response.status}\n`);
      process.exit(1);
      return;
    }
  }

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
