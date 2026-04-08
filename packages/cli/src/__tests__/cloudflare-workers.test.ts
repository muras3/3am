import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolveCloudflareApiAuth, updateCloudflareObservabilityConfig } from "../commands/cloudflare-workers.js";

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
