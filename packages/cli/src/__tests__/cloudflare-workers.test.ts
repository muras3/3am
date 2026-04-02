import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import { existsSync, readFileSync } from "node:fs";
import { resolveCloudflareApiAuth } from "../commands/cloudflare-workers.js";

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
