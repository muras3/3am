import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock node:fs at top level so resolveApiKey's loadCredentials / saveCredentials use it
vi.mock("node:fs", async (importOriginal) => {
  const mod = await importOriginal() as Record<string, unknown>;
  return {
    ...mod,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => "{}"),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    chmodSync: vi.fn(),
  };
});

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  canonicalizeReceiverUrl,
  findReceiverCredentialByUrl,
  setReceiverCredential,
  resolveApiKey,
} from "../commands/init/credentials.js";
import type { Credentials } from "../commands/init/credentials.js";

// ---------------------------------------------------------------------------
// resolveApiKey — priority: CLI flag > stored credential > env var > prompt
// (Bug 1 regression tests)
// ---------------------------------------------------------------------------

describe("resolveApiKey() — priority (Bug 1)", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockReturnValue("{}");
    vi.mocked(writeFileSync).mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env["ANTHROPIC_API_KEY"] = savedEnv;
    } else {
      delete process.env["ANTHROPIC_API_KEY"];
    }
    vi.restoreAllMocks();
  });

  it("returns CLI flag value when --api-key is passed", async () => {
    const key = await resolveApiKey({ apiKey: "sk-flag", noInteractive: true });
    expect(key).toBe("sk-flag");
  });

  it("prefers stored credential over env var when both exist (Bug 1 fix)", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-env";
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ anthropicApiKey: "sk-stored" }));

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const key = await resolveApiKey({ noInteractive: true });
    expect(key).toBe("sk-stored");
    // Should warn the user about the mismatch so they know which key is being used
    const warnOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(warnOutput).toContain("ANTHROPIC_API_KEY env var differs");
    stderrSpy.mockRestore();
  });

  it("does NOT warn when env var matches stored credential", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-same";
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ anthropicApiKey: "sk-same" }));

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const key = await resolveApiKey({ noInteractive: true });
    expect(key).toBe("sk-same");
    const warnOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(warnOutput).not.toContain("env var differs");
    stderrSpy.mockRestore();
  });

  it("falls back to env var when no stored credential exists", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-env-only";
    // No credentials file
    vi.mocked(existsSync).mockReturnValue(false);

    const key = await resolveApiKey({ noInteractive: true });
    expect(key).toBe("sk-env-only");
  });

  it("returns undefined in noInteractive mode when no key is available", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const key = await resolveApiKey({ noInteractive: true });
    expect(key).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// canonicalizeReceiverUrl
// ---------------------------------------------------------------------------

describe("canonicalizeReceiverUrl()", () => {
  it("returns URL unchanged when already canonical", () => {
    expect(canonicalizeReceiverUrl("https://example.com")).toBe("https://example.com/");
  });

  it("strips trailing slash from path", () => {
    expect(canonicalizeReceiverUrl("https://example.com/")).toBe("https://example.com/");
    expect(canonicalizeReceiverUrl("https://example.com/path/")).toBe("https://example.com/path");
  });

  it("lowercases the host", () => {
    expect(canonicalizeReceiverUrl("https://EXAMPLE.COM/")).toBe("https://example.com/");
    expect(canonicalizeReceiverUrl("https://Example.Com/path")).toBe("https://example.com/path");
  });

  it("strips default https port 443", () => {
    expect(canonicalizeReceiverUrl("https://example.com:443")).toBe("https://example.com/");
    expect(canonicalizeReceiverUrl("https://example.com:443/path")).toBe("https://example.com/path");
  });

  it("strips default http port 80", () => {
    expect(canonicalizeReceiverUrl("http://example.com:80")).toBe("http://example.com/");
    expect(canonicalizeReceiverUrl("http://example.com:80/path")).toBe("http://example.com/path");
  });

  it("preserves non-default ports", () => {
    expect(canonicalizeReceiverUrl("https://example.com:8443/")).toBe("https://example.com:8443/");
    expect(canonicalizeReceiverUrl("http://example.com:3000/")).toBe("http://example.com:3000/");
  });

  it("preserves non-trivial paths", () => {
    expect(canonicalizeReceiverUrl("https://example.com/api/v1")).toBe("https://example.com/api/v1");
  });

  it("returns original string for invalid URLs", () => {
    const invalid = "not-a-url";
    expect(canonicalizeReceiverUrl(invalid)).toBe(invalid);
  });

  it("does not confuse http and https schemes", () => {
    const http = canonicalizeReceiverUrl("http://example.com/");
    const https = canonicalizeReceiverUrl("https://example.com/");
    expect(http).not.toBe(https);
    expect(http.startsWith("http://")).toBe(true);
    expect(https.startsWith("https://")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findReceiverCredentialByUrl — URL variant matching
// ---------------------------------------------------------------------------

describe("findReceiverCredentialByUrl()", () => {
  const makeCredsWithReceiver = (storedUrl: string): Credentials => ({
    receivers: {
      vercel: {
        url: storedUrl,
        authToken: "tok-abc",
        updatedAt: new Date().toISOString(),
      },
    },
  });

  it("matches exact URL", () => {
    const creds = makeCredsWithReceiver("https://example.com");
    expect(findReceiverCredentialByUrl(creds, "https://example.com")?.authToken).toBe("tok-abc");
  });

  it("matches URL with trailing slash against stored URL without", () => {
    const creds = makeCredsWithReceiver("https://example.com");
    expect(findReceiverCredentialByUrl(creds, "https://example.com/")?.authToken).toBe("tok-abc");
  });

  it("matches URL without trailing slash against stored URL with", () => {
    const creds = makeCredsWithReceiver("https://example.com/");
    expect(findReceiverCredentialByUrl(creds, "https://example.com")?.authToken).toBe("tok-abc");
  });

  it("matches uppercase host against lowercase stored URL", () => {
    const creds = makeCredsWithReceiver("https://example.com");
    expect(findReceiverCredentialByUrl(creds, "https://EXAMPLE.COM/")?.authToken).toBe("tok-abc");
  });

  it("matches explicit :443 against stored URL without port", () => {
    const creds = makeCredsWithReceiver("https://example.com");
    expect(findReceiverCredentialByUrl(creds, "https://example.com:443")?.authToken).toBe("tok-abc");
  });

  it("does NOT match different scheme (http vs https)", () => {
    const creds = makeCredsWithReceiver("https://example.com");
    expect(findReceiverCredentialByUrl(creds, "http://example.com")).toBeUndefined();
  });

  it("does NOT match different host", () => {
    const creds = makeCredsWithReceiver("https://example.com");
    expect(findReceiverCredentialByUrl(creds, "https://other.com")).toBeUndefined();
  });

  it("falls back to legacy receiverUrl field with canonicalization", () => {
    const creds: Credentials = {
      receiverUrl: "https://example.com",
      receiverAuthToken: "tok-legacy",
    };
    expect(findReceiverCredentialByUrl(creds, "https://example.com:443/")?.authToken).toBe("tok-legacy");
  });

  it("returns undefined when no credentials stored", () => {
    expect(findReceiverCredentialByUrl({}, "https://example.com")).toBeUndefined();
  });

  it("prefers platform-scoped receiver over legacy field", () => {
    const creds: Credentials = {
      receiverUrl: "https://example.com",
      receiverAuthToken: "tok-legacy",
      receivers: {
        vercel: {
          url: "https://example.com",
          authToken: "tok-scoped",
          updatedAt: new Date().toISOString(),
        },
      },
    };
    expect(findReceiverCredentialByUrl(creds, "https://example.com/")?.authToken).toBe("tok-scoped");
  });
});

// ---------------------------------------------------------------------------
// setReceiverCredential — storage format unchanged (backward compat)
// ---------------------------------------------------------------------------

describe("setReceiverCredential()", () => {
  it("stores URL as-is without modification", () => {
    const result = setReceiverCredential({}, "vercel", {
      url: "https://example.com/",
      authToken: "tok",
    });
    expect(result.receiverUrl).toBe("https://example.com/");
    expect(result.receivers?.vercel?.url).toBe("https://example.com/");
  });

  it("preserves existing receivers for other platforms", () => {
    const existing: Credentials = {
      receivers: {
        cloudflare: {
          url: "https://cf.workers.dev",
          authToken: "cf-tok",
          updatedAt: new Date().toISOString(),
        },
      },
    };
    const result = setReceiverCredential(existing, "vercel", {
      url: "https://example.vercel.app",
      authToken: "v-tok",
    });
    expect(result.receivers?.cloudflare?.authToken).toBe("cf-tok");
    expect(result.receivers?.vercel?.authToken).toBe("v-tok");
  });
});
