import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

type JsonMap = Record<string, unknown>;

export interface CloudflareObservabilityTargets {
  traceDestination?: string;
  logDestination?: string;
}

export interface CloudflareObservabilityState {
  changed: boolean;
  workerName: string;
  configPath: string;
}

export interface CloudflareAccountInfo {
  accountId: string;
  email?: string;
}

export interface CloudflareApiAuth {
  headers: Record<string, string>;
  source: "api-token" | "global-key";
}

interface CloudflareDestination {
  slug: string;
  name: string;
  enabled: boolean;
  configuration: {
    headers?: Record<string, string>;
    logpushDataset: "opentelemetry-traces" | "opentelemetry-logs";
    type: "logpush";
    url: string;
  };
}

interface CloudflareApiResponse<T> {
  success: boolean;
  errors: Array<{ code?: number; message: string }>;
  messages: Array<{ message: string }>;
  result: T;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureTomlTable(content: string, table: string, entries: Record<string, string>): string {
  const header = `[${table}]`;
  const tableRegex = new RegExp(`(^\\[${escapeRegExp(table)}\\]\\n[\\s\\S]*?)(?=^\\[|\\Z)`, "m");
  const entryLines = Object.entries(entries);

  if (tableRegex.test(content)) {
    return content.replace(tableRegex, (block) => {
      let updated = block;
      for (const [key, value] of entryLines) {
        const keyRegex = new RegExp(`^${escapeRegExp(key)}\\s*=.*$`, "m");
        const line = `${key} = ${value}`;
        if (keyRegex.test(updated)) {
          updated = updated.replace(keyRegex, line);
        } else {
          updated = updated.endsWith("\n") ? `${updated}${line}\n` : `${updated}\n${line}\n`;
        }
      }
      return updated;
    });
  }

  const block = [
    header,
    ...entryLines.map(([key, value]) => `${key} = ${value}`),
    "",
  ].join("\n");

  return content.trimEnd() === "" ? `${block}\n` : `${content.trimEnd()}\n\n${block}\n`;
}

function stripJsonComments(source: string): string {
  let result = "";
  let inString = false;
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    const next = source[i + 1];

    if (inString) {
      result += char;
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === quote) {
        inString = false;
        quote = null;
      }
      continue;
    }

    if ((char === "\"" || char === "'")) {
      inString = true;
      quote = char;
      result += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      result += "\n";
      continue;
    }

    if (char === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }

    result += char;
  }

  return result;
}

function parseJsoncObject(content: string): JsonMap {
  const stripped = stripJsonComments(content).replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(stripped) as JsonMap;
}

function stringifyJsoncObject(value: JsonMap): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function mergeDestinationList(existing: unknown, nextValue: string | undefined): string[] | undefined {
  if (!nextValue) {
    return Array.isArray(existing)
      ? existing.filter((item): item is string => typeof item === "string")
      : undefined;
  }

  const current = Array.isArray(existing)
    ? existing.filter((item): item is string => typeof item === "string")
    : [];

  return current.includes(nextValue) ? current : [...current, nextValue];
}

function updateWranglerToml(content: string, targets: CloudflareObservabilityTargets): string {
  let updated = content;
  updated = ensureTomlTable(updated, "observability", { enabled: "true" });
  updated = ensureTomlTable(updated, "observability.logs", {
    enabled: "true",
    invocation_logs: "true",
    ...(targets.logDestination ? { destinations: `["${targets.logDestination}"]` } : {}),
  });
  updated = ensureTomlTable(updated, "observability.traces", {
    enabled: "true",
    head_sampling_rate: "1.0",
    ...(targets.traceDestination ? { destinations: `["${targets.traceDestination}"]` } : {}),
  });
  // persist = false blocks Cloudflare from pushing data to destinations — remove it
  updated = updated.replace(/^persist\s*=\s*false\s*\n?/gm, "");
  return updated;
}

function updateWranglerJsonc(content: string, targets: CloudflareObservabilityTargets): string {
  const parsed = parseJsoncObject(content);
  const observability = ((parsed["observability"] as JsonMap | undefined) ?? {});
  const logs = ((observability["logs"] as JsonMap | undefined) ?? {});
  const traces = ((observability["traces"] as JsonMap | undefined) ?? {});

  const logsConfig: JsonMap = {
    ...logs,
    enabled: true,
    invocation_logs: true,
    ...(targets.logDestination ? { destinations: mergeDestinationList(logs["destinations"], targets.logDestination) } : {}),
  };
  // persist: false blocks Cloudflare from pushing logs to destinations — remove it
  delete logsConfig["persist"];

  const tracesConfig: JsonMap = {
    ...traces,
    enabled: true,
    head_sampling_rate: 1,
    ...(targets.traceDestination ? { destinations: mergeDestinationList(traces["destinations"], targets.traceDestination) } : {}),
  };
  // persist: false blocks Cloudflare from pushing traces to destinations — remove it
  delete tracesConfig["persist"];

  parsed["observability"] = {
    ...observability,
    enabled: true,
    logs: logsConfig,
    traces: tracesConfig,
  };

  return stringifyJsoncObject(parsed);
}

function parseWorkerNameFromToml(content: string): string | null {
  return content.match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? null;
}

function parseWorkerName(path: string, content: string): string | null {
  if (path.endsWith(".jsonc")) {
    const parsed = parseJsoncObject(content);
    return typeof parsed["name"] === "string" ? parsed["name"] : null;
  }
  return parseWorkerNameFromToml(content);
}

export function updateCloudflareObservabilityConfig(
  path: string,
  targets: CloudflareObservabilityTargets = {},
): boolean {
  const content = readFileSync(path, "utf-8");
  const updated = path.endsWith(".jsonc")
    ? updateWranglerJsonc(content, targets)
    : updateWranglerToml(content, targets);

  if (updated === content) return false;

  writeFileSync(path, updated, "utf-8");
  return true;
}

export function resolveCloudflareWorker(path: string): { workerName: string } {
  const content = readFileSync(path, "utf-8");
  const workerName = parseWorkerName(path, content);
  if (!workerName) {
    throw new Error(`Could not determine Cloudflare Worker name from ${path}`);
  }
  return { workerName };
}

function getCloudflareLegacyConfigPath(): string | null {
  const candidates = [
    join(homedir(), ".cloudflare", "config"),
    join(homedir(), ".cloudflare", "config.json"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function getCloudflareApiKeyFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return env["CLOUDFLARE_API_KEY"] ?? env["CF_API_KEY"];
}

function getCloudflareEmailFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return env["CLOUDFLARE_EMAIL"] ?? env["CF_EMAIL"];
}

async function cloudflareApiFetch<T>(
  auth: CloudflareApiAuth,
  accountId: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...auth.headers,
      ...(init.headers ?? {}),
    },
  });

  const body = await response.json() as CloudflareApiResponse<T>;
  if (!response.ok || !body.success) {
    const message = body.errors?.map((error) => error.message).join("; ")
      || `Cloudflare API request failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  return body.result;
}

export function getCloudflareAccountInfo(): CloudflareAccountInfo {
  const output = execFileSync("wrangler", ["whoami", "--json"], {
    stdio: "pipe",
  }).toString();

  const parsed = JSON.parse(output) as {
    email?: string;
    accounts?: Array<{ id?: string }>;
  };
  const accountId = parsed.accounts?.[0]?.id;
  if (!accountId) {
    throw new Error("Could not determine Cloudflare account ID from `wrangler whoami --json`");
  }
  return { accountId, email: parsed.email };
}

async function promptSecret(prompt: string): Promise<string> {
  process.stdout.write(prompt);

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
        process.stdout.write("\n");
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.exit(1);
      } else if (code === 0x0d || code === 0x0a) {
        process.stdout.write("\n");
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        resolve(value.trim());
      } else if ((code === 0x7f || code === 0x08) && value.length > 0) {
        value = value.slice(0, -1);
      } else if (code >= 0x20) {
        value += ch;
      }
    };

    stdin.on("data", onData);
  });
}

function readLegacyGlobalApiKey(): string | undefined {
  const path = getCloudflareLegacyConfigPath();
  if (!path) return undefined;
  const content = readFileSync(path, "utf-8");
  const tomlMatch = content.match(/^api_key\s*=\s*"(.*)"$/m)?.[1];
  if (tomlMatch) return tomlMatch;

  try {
    const parsed = JSON.parse(content) as { api_key?: string };
    return parsed.api_key;
  } catch {
    return undefined;
  }
}

export async function resolveCloudflareApiAuth(options: {
  env?: NodeJS.ProcessEnv;
  account?: { email?: string };
  noInteractive?: boolean;
}): Promise<CloudflareApiAuth> {
  const env = options.env ?? process.env;
  const apiToken = env["CLOUDFLARE_API_TOKEN"] ?? env["CF_API_TOKEN"];
  if (apiToken) {
    return {
      source: "api-token",
      headers: { Authorization: `Bearer ${apiToken}` },
    };
  }

  const email = getCloudflareEmailFromEnv(env) ?? options.account?.email;
  const apiKey = getCloudflareApiKeyFromEnv(env) ?? readLegacyGlobalApiKey();

  if (email && apiKey) {
    return {
      source: "global-key",
      headers: {
        "X-Auth-Email": email,
        "X-Auth-Key": apiKey,
      },
    };
  }

  if (options.noInteractive) {
    throw new Error(
      "Cloudflare Observability destination setup requires CLOUDFLARE_API_TOKEN. " +
      "For initial OSS setup, create a Cloudflare API Token with Account Settings:Read, Workers Scripts:Edit, D1:Edit, Cloudflare Queues:Edit, and Workers Observability:Edit, then export CLOUDFLARE_API_TOKEN before running `3am deploy cloudflare`.",
    );
  }

  if (!email) {
    throw new Error(
      "Could not determine Cloudflare email. Set CLOUDFLARE_EMAIL or re-run `wrangler whoami` successfully.",
    );
  }

  process.stdout.write(
    "Cloudflare OTLP destination setup works best with CLOUDFLARE_API_TOKEN. " +
    "Falling back to Global API Key for this interactive run.\n",
  );
  const promptedApiKey = await promptSecret("Enter your Cloudflare Global API Key: ");
  if (!promptedApiKey) {
    throw new Error("Cloudflare Global API Key is required to configure Observability destinations.");
  }

  return {
    source: "global-key",
    headers: {
      "X-Auth-Email": email,
      "X-Auth-Key": promptedApiKey,
    },
  };
}

function buildDestinationName(workerName: string, kind: "traces" | "logs"): string {
  return `${workerName}-3am-${kind}`;
}

async function listDestinations(auth: CloudflareApiAuth, accountId: string): Promise<CloudflareDestination[]> {
  return cloudflareApiFetch<CloudflareDestination[]>(
    auth,
    accountId,
    "/workers/observability/destinations",
    { method: "GET" },
  );
}

async function createDestination(
  auth: CloudflareApiAuth,
  accountId: string,
  name: string,
  dataset: "opentelemetry-traces" | "opentelemetry-logs",
  url: string,
  headers: Record<string, string>,
): Promise<void> {
  await cloudflareApiFetch<CloudflareDestination>(
    auth,
    accountId,
    "/workers/observability/destinations",
    {
      method: "POST",
      body: JSON.stringify({
        name,
        enabled: true,
        configuration: {
          type: "logpush",
          logpushDataset: dataset,
          url,
          headers,
        },
      }),
    },
  );
}

async function updateDestination(
  auth: CloudflareApiAuth,
  accountId: string,
  slug: string,
  url: string,
  headers: Record<string, string>,
): Promise<void> {
  await cloudflareApiFetch<CloudflareDestination>(
    auth,
    accountId,
    `/workers/observability/destinations/${slug}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        enabled: true,
        configuration: {
          type: "logpush",
          url,
          headers,
        },
      }),
    },
  );
}

async function ensureDestination(
  auth: CloudflareApiAuth,
  accountId: string,
  workerName: string,
  kind: "traces" | "logs",
  url: string,
  authToken: string,
): Promise<string> {
  const dataset = kind === "traces" ? "opentelemetry-traces" : "opentelemetry-logs";
  const name = buildDestinationName(workerName, kind);
  const headers = { Authorization: `Bearer ${authToken}` };
  const destinations = await listDestinations(auth, accountId);
  const existing = destinations.find((destination) => destination.name === name);

  if (!existing) {
    await createDestination(auth, accountId, name, dataset, url, headers);
    return name;
  }

  const sameUrl = existing.configuration.url === url;
  const sameHeader = existing.configuration.headers?.["Authorization"] === headers["Authorization"];
  const sameEnabled = existing.enabled === true;

  if (!sameUrl || !sameHeader || !sameEnabled) {
    await updateDestination(auth, accountId, existing.slug, url, headers);
  }

  return name;
}

export async function connectCloudflareWorkerToReceiver(
  cwd: string,
  receiverUrl: string,
  authToken: string,
  options: { noInteractive?: boolean } = {},
): Promise<CloudflareObservabilityState> {
  const configPath = join(cwd, existsSync(join(cwd, "wrangler.jsonc")) ? "wrangler.jsonc" : "wrangler.toml");
  if (!existsSync(configPath)) {
    throw new Error("No wrangler.toml or wrangler.jsonc found in the current directory");
  }

  const { workerName } = resolveCloudflareWorker(configPath);
  const account = getCloudflareAccountInfo();
  const cloudflareAuth = await resolveCloudflareApiAuth({
    account,
    noInteractive: options.noInteractive,
  });
  const traceDestination = await ensureDestination(
    cloudflareAuth,
    account.accountId,
    workerName,
    "traces",
    `${receiverUrl}/v1/traces`,
    authToken,
  );
  const logDestination = await ensureDestination(
    cloudflareAuth,
    account.accountId,
    workerName,
    "logs",
    `${receiverUrl}/v1/logs`,
    authToken,
  );
  const changed = updateCloudflareObservabilityConfig(configPath, {
    traceDestination,
    logDestination,
  });

  execFileSync("wrangler", ["deploy"], {
    cwd,
    stdio: "inherit",
  });

  return {
    changed,
    workerName,
    configPath,
  };
}
