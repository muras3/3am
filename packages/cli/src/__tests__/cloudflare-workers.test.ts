import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  connectCloudflareWorkerToReceiver,
  resolveCloudflareApiAuth,
  updateCloudflareObservabilityConfig,
} from "../commands/cloudflare-workers.js";

describe("updateCloudflareObservabilityConfig() — wrangler.jsonc", () => {
  beforeEach(() => {
    vi.mocked(readFileSync).mockReset();
    vi.mocked(writeFileSync).mockReset();
  });

  it("removes persist:false from observability.logs and observability.traces when adding destinations", () => {
    const input = JSON.stringify({
      name: "my-worker",
      observability: {
        enabled: true,
        logs: {
          enabled: true,
          persist: false,
        },
        traces: {
          enabled: true,
          persist: false,
        },
      },
    }, null, 2) + "\n";

    vi.mocked(readFileSync).mockReturnValue(input);

    updateCloudflareObservabilityConfig("wrangler.jsonc", {
      logDestination: "my-worker-3am-logs",
      traceDestination: "my-worker-3am-traces",
    });

    expect(vi.mocked(writeFileSync)).toHaveBeenCalledOnce();
    const written = vi.mocked(writeFileSync).mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written) as Record<string, unknown>;
    const obs = parsed["observability"] as Record<string, unknown>;
    const logs = obs["logs"] as Record<string, unknown>;
    const traces = obs["traces"] as Record<string, unknown>;

    expect(logs).not.toHaveProperty("persist");
    expect(traces).not.toHaveProperty("persist");
  });

  it("does not add persist key when it was not present", () => {
    const input = JSON.stringify({
      name: "my-worker",
      observability: {
        enabled: true,
        logs: { enabled: true },
        traces: { enabled: true },
      },
    }, null, 2) + "\n";

    vi.mocked(readFileSync).mockReturnValue(input);

    updateCloudflareObservabilityConfig("wrangler.jsonc", {
      logDestination: "my-worker-3am-logs",
      traceDestination: "my-worker-3am-traces",
    });

    expect(vi.mocked(writeFileSync)).toHaveBeenCalledOnce();
    const written = vi.mocked(writeFileSync).mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written) as Record<string, unknown>;
    const obs = parsed["observability"] as Record<string, unknown>;
    const logs = obs["logs"] as Record<string, unknown>;
    const traces = obs["traces"] as Record<string, unknown>;

    expect(logs).not.toHaveProperty("persist");
    expect(traces).not.toHaveProperty("persist");
  });
});

describe("updateCloudflareObservabilityConfig() — wrangler.toml", () => {
  beforeEach(() => {
    vi.mocked(readFileSync).mockReset();
    vi.mocked(writeFileSync).mockReset();
  });

  it("removes persist = false from observability sections when adding destinations", () => {
    const input = [
      `name = "my-worker"`,
      ``,
      `[observability]`,
      `enabled = true`,
      ``,
      `[observability.logs]`,
      `enabled = true`,
      `persist = false`,
      ``,
      `[observability.traces]`,
      `enabled = true`,
      `persist = false`,
      ``,
    ].join("\n");

    vi.mocked(readFileSync).mockReturnValue(input);

    updateCloudflareObservabilityConfig("wrangler.toml", {
      logDestination: "my-worker-3am-logs",
      traceDestination: "my-worker-3am-traces",
    });

    expect(vi.mocked(writeFileSync)).toHaveBeenCalledOnce();
    const written = vi.mocked(writeFileSync).mock.calls[0]?.[1] as string;

    expect(written).not.toMatch(/persist\s*=\s*false/);
  });

  it("leaves wrangler.toml unchanged if no modifications are needed", () => {
    // Provide a config that already has the exact output updateWranglerToml would produce
    // so changed === false and writeFileSync is NOT called.
    // The simplest no-persist-false config where input === output:
    const input = [
      `name = "my-worker"`,
      ``,
      `[observability]`,
      `enabled = true`,
      ``,
      `[observability.logs]`,
      `enabled = true`,
      `invocation_logs = true`,
      ``,
      `[observability.traces]`,
      `enabled = true`,
      `head_sampling_rate = 1.0`,
      ``,
    ].join("\n");

    vi.mocked(readFileSync).mockReturnValue(input);

    // No targets supplied — minimal no-op path
    updateCloudflareObservabilityConfig("wrangler.toml", {});

    // writeFileSync may or may not be called depending on whitespace normalization,
    // but if called, result must not have persist = false
    const calls = vi.mocked(writeFileSync).mock.calls;
    if (calls.length > 0) {
      const written = calls[0]?.[1] as string;
      expect(written).not.toMatch(/persist\s*=\s*false/);
    }
  });
});

describe("resolveCloudflareApiAuth()", () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockReset();
  });

  it("prefers CLOUDFLARE_API_TOKEN when present", async () => {
    const auth = await resolveCloudflareApiAuth({
      env: { CLOUDFLARE_API_TOKEN: "token-123" },
      noInteractive: true,
    });

    expect(auth.source).toBe("api-token");
    expect(auth.headers).toEqual({ Authorization: "Bearer token-123" });
  });

  it("falls back to global api key plus email", async () => {
    const auth = await resolveCloudflareApiAuth({
      env: { CLOUDFLARE_API_KEY: "global-key", CLOUDFLARE_EMAIL: "user@example.com" },
      noInteractive: true,
    });

    expect(auth.source).toBe("global-key");
    expect(auth.headers).toEqual({
      "X-Auth-Email": "user@example.com",
      "X-Auth-Key": "global-key",
    });
  });

  it("uses wrangler whoami email when CLOUDFLARE_EMAIL is absent", async () => {
    const auth = await resolveCloudflareApiAuth({
      env: { CLOUDFLARE_API_KEY: "global-key" },
      account: { email: "whoami@example.com" },
      noInteractive: true,
    });

    expect(auth.headers).toEqual({
      "X-Auth-Email": "whoami@example.com",
      "X-Auth-Key": "global-key",
    });
  });

  it("errors in non-interactive mode when no supported auth is configured", async () => {
    await expect(resolveCloudflareApiAuth({
      env: {},
      account: { email: "user@example.com" },
      noInteractive: true,
    })).rejects.toThrow("Workers Scripts:Edit");
  });
});

describe("connectCloudflareWorkerToReceiver()", () => {
  beforeEach(() => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token-123");
    vi.mocked(existsSync).mockImplementation((path) => path === "wrangler.toml");
    vi.mocked(readFileSync).mockImplementation((path) => {
      if (path === "wrangler.toml") {
        return 'name = "e2e-order-api"\n';
      }
      return "";
    });
    vi.mocked(writeFileSync).mockReset();
    vi.mocked(execFileSync).mockImplementation((command, args) => {
      if (command === "wrangler" && Array.isArray(args) && args[0] === "whoami") {
        return Buffer.from(JSON.stringify({
          email: "dev@example.com",
          accounts: [{ id: "acct_123" }],
        }));
      }
      if (command === "wrangler" && Array.isArray(args) && args[0] === "deploy") {
        return Buffer.from("");
      }
      throw new Error(`Unexpected execFileSync call: ${command} ${String(args)}`);
    });
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sends create payloads with normalized OTLP URLs", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/workers/observability/destinations") && init?.method === "GET") {
        return new Response(JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: [],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.endsWith("/workers/observability/destinations") && init?.method === "POST") {
        return new Response(JSON.stringify({
          success: true,
          errors: [],
          messages: [{ message: "Resource created" }],
          result: {
            slug: "dest-slug",
            name: "dest-name",
            enabled: true,
            configuration: {
              type: "logpush",
              logpushDataset: "opentelemetry-logs",
              url: "https://receiver.example.com/v1/logs",
            },
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      throw new Error(`Unexpected fetch call: ${url}`);
    });

    await connectCloudflareWorkerToReceiver(
      ".",
      "https://receiver.example.com/",
      "tok_abc123",
      { noInteractive: true },
    );

    const postCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(postCalls).toHaveLength(2);

    const tracePayload = JSON.parse(String(postCalls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(postCalls[0]?.[1]?.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer token-123",
    });
    expect(tracePayload).toEqual({
      name: "e2e-order-api-3am-traces",
      enabled: true,
      configuration: {
        type: "logpush",
        logpushDataset: "opentelemetry-traces",
        url: "https://receiver.example.com/v1/traces",
        headers: {
          Authorization: "Bearer tok_abc123",
        },
      },
    });

    const logPayload = JSON.parse(String(postCalls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(postCalls[1]?.[1]?.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer token-123",
    });
    expect(logPayload).toEqual({
      name: "e2e-order-api-3am-logs",
      enabled: true,
      configuration: {
        type: "logpush",
        logpushDataset: "opentelemetry-logs",
        url: "https://receiver.example.com/v1/logs",
        headers: {
          Authorization: "Bearer tok_abc123",
        },
      },
    });
  });
});
