import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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

interface WranglerAuthConfig {
  oauthToken?: string;
  refreshToken?: string;
  expirationTime?: string;
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

const WRANGLER_CLIENT_ID = "54d11594-84e4-41aa-b438-e81b8fa78ee7";
const WRANGLER_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";

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
  return updated;
}

function updateWranglerJsonc(content: string, targets: CloudflareObservabilityTargets): string {
  const parsed = parseJsoncObject(content);
  const observability = ((parsed["observability"] as JsonMap | undefined) ?? {});
  const logs = ((observability["logs"] as JsonMap | undefined) ?? {});
  const traces = ((observability["traces"] as JsonMap | undefined) ?? {});

  parsed["observability"] = {
    ...observability,
    enabled: true,
    logs: {
      ...logs,
      enabled: true,
      invocation_logs: true,
      ...(targets.logDestination ? { destinations: mergeDestinationList(logs["destinations"], targets.logDestination) } : {}),
    },
    traces: {
      ...traces,
      enabled: true,
      head_sampling_rate: 1,
      ...(targets.traceDestination ? { destinations: mergeDestinationList(traces["destinations"], targets.traceDestination) } : {}),
    },
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

function getWranglerAuthConfigPath(): string {
  const candidates = [
    join(homedir(), "Library", "Preferences", ".wrangler", "config", "default.toml"),
    join(homedir(), ".config", ".wrangler", "config", "default.toml"),
    join(homedir(), ".wrangler", "config", "default.toml"),
  ];

  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) {
    throw new Error("Wrangler auth config not found. Run `wrangler login` first.");
  }
  return path;
}

function parseWranglerAuthConfig(path: string): WranglerAuthConfig {
  const content = readFileSync(path, "utf-8");
  const getValue = (key: string): string | undefined =>
    content.match(new RegExp(`^${escapeRegExp(key)}\\s*=\\s*"(.*)"$`, "m"))?.[1];

  return {
    oauthToken: getValue("oauth_token"),
    refreshToken: getValue("refresh_token"),
    expirationTime: getValue("expiration_time"),
  };
}

function writeWranglerAuthConfig(path: string, auth: WranglerAuthConfig): void {
  let content = readFileSync(path, "utf-8");
  const replace = (key: string, value: string | undefined) => {
    if (!value) return;
    const regex = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*".*"$`, "m");
    const line = `${key} = "${value}"`;
    content = regex.test(content)
      ? content.replace(regex, line)
      : `${content.trimEnd()}\n${line}\n`;
  };

  replace("oauth_token", auth.oauthToken);
  replace("refresh_token", auth.refreshToken);
  replace("expiration_time", auth.expirationTime);
  writeFileSync(path, content, "utf-8");
}

async function refreshCloudflareOAuthToken(refreshToken: string): Promise<WranglerAuthConfig> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: WRANGLER_CLIENT_ID,
  });

  const response = await fetch(WRANGLER_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    throw new Error(`Cloudflare OAuth refresh failed with HTTP ${response.status}`);
  }

  const body = await response.json() as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
  };

  if (!body.access_token || !body.expires_in) {
    throw new Error("Cloudflare OAuth refresh returned an invalid response");
  }

  return {
    oauthToken: body.access_token,
    refreshToken: body.refresh_token ?? refreshToken,
    expirationTime: new Date(Date.now() + body.expires_in * 1000).toISOString(),
  };
}

async function getCloudflareApiToken(forceRefresh = false): Promise<string> {
  const configPath = getWranglerAuthConfigPath();
  const auth = parseWranglerAuthConfig(configPath);
  const expired = !auth.expirationTime || Date.parse(auth.expirationTime) <= Date.now() + 60_000;

  if (!forceRefresh && auth.oauthToken && !expired) {
    return auth.oauthToken;
  }

  if (!auth.refreshToken) {
    throw new Error("Wrangler OAuth refresh token not found. Re-run `wrangler login`.");
  }

  const refreshed = await refreshCloudflareOAuthToken(auth.refreshToken);
  writeWranglerAuthConfig(configPath, refreshed);

  if (!refreshed.oauthToken) {
    throw new Error("Cloudflare OAuth refresh did not return an access token");
  }

  return refreshed.oauthToken;
}

async function cloudflareApiFetch<T>(
  accountId: string,
  path: string,
  init: RequestInit = {},
  retry = true,
): Promise<T> {
  const token = await getCloudflareApiToken(false);
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });

  if (response.status === 401 && retry) {
    await getCloudflareApiToken(true);
    return cloudflareApiFetch<T>(accountId, path, init, false);
  }

  const body = await response.json() as CloudflareApiResponse<T>;
  if (!response.ok || !body.success) {
    const message = body.errors?.map((error) => error.message).join("; ")
      || `Cloudflare API request failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  return body.result;
}

export function getCloudflareAccountId(): string {
  const output = execFileSync("wrangler", ["whoami", "--json"], {
    stdio: "pipe",
  }).toString();

  const parsed = JSON.parse(output) as {
    accounts?: Array<{ id?: string }>;
  };
  const accountId = parsed.accounts?.[0]?.id;
  if (!accountId) {
    throw new Error("Could not determine Cloudflare account ID from `wrangler whoami --json`");
  }
  return accountId;
}

function buildDestinationName(workerName: string, kind: "traces" | "logs"): string {
  return `${workerName}-3amoncall-${kind}`;
}

async function listDestinations(accountId: string): Promise<CloudflareDestination[]> {
  return cloudflareApiFetch<CloudflareDestination[]>(
    accountId,
    "/workers/observability/destinations",
    { method: "GET" },
  );
}

async function createDestination(
  accountId: string,
  name: string,
  dataset: "opentelemetry-traces" | "opentelemetry-logs",
  url: string,
  headers: Record<string, string>,
): Promise<void> {
  await cloudflareApiFetch<CloudflareDestination>(
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
  accountId: string,
  slug: string,
  url: string,
  headers: Record<string, string>,
): Promise<void> {
  await cloudflareApiFetch<CloudflareDestination>(
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
  accountId: string,
  workerName: string,
  kind: "traces" | "logs",
  url: string,
  authToken: string,
): Promise<string> {
  const dataset = kind === "traces" ? "opentelemetry-traces" : "opentelemetry-logs";
  const name = buildDestinationName(workerName, kind);
  const headers = { Authorization: `Bearer ${authToken}` };
  const destinations = await listDestinations(accountId);
  const existing = destinations.find((destination) => destination.name === name);

  if (!existing) {
    await createDestination(accountId, name, dataset, url, headers);
    return name;
  }

  const sameUrl = existing.configuration.url === url;
  const sameHeader = existing.configuration.headers?.["Authorization"] === headers["Authorization"];
  const sameEnabled = existing.enabled === true;

  if (!sameUrl || !sameHeader || !sameEnabled) {
    await updateDestination(accountId, existing.slug, url, headers);
  }

  return name;
}

export async function connectCloudflareWorkerToReceiver(
  cwd: string,
  receiverUrl: string,
  authToken: string,
): Promise<CloudflareObservabilityState> {
  const configPath = join(cwd, existsSync(join(cwd, "wrangler.jsonc")) ? "wrangler.jsonc" : "wrangler.toml");
  if (!existsSync(configPath)) {
    throw new Error("No wrangler.toml or wrangler.jsonc found in the current directory");
  }

  const { workerName } = resolveCloudflareWorker(configPath);
  const accountId = getCloudflareAccountId();
  const traceDestination = await ensureDestination(
    accountId,
    workerName,
    "traces",
    `${receiverUrl}/v1/traces`,
    authToken,
  );
  const logDestination = await ensureDestination(
    accountId,
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
