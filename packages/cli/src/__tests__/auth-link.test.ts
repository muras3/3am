/**
 * Tests for auth-link cross-receiver token selection (Bug 4).
 *
 * Before fix: auth-link silently fell back to receiverAuthToken (wrong platform)
 * when the explicit URL didn't match any stored receiver credential.
 *
 * After fix: When a URL is explicitly passed and no match is found, the command
 * errors with a clear message listing available receivers. The --auth-token flag
 * provides an explicit override.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock credentials and health modules
vi.mock("../commands/init/credentials.js", () => ({
  loadCredentials: vi.fn(),
  findReceiverCredentialByUrl: vi.fn(),
}));

vi.mock("../commands/shared/health.js", () => ({
  createClaimTokenWithRetry: vi.fn(),
  buildClaimUrl: vi.fn((url: string, token: string) => `${url}/claim?token=${token}`),
}));

import { loadCredentials, findReceiverCredentialByUrl } from "../commands/init/credentials.js";
import { createClaimTokenWithRetry } from "../commands/shared/health.js";
import { runAuthLink } from "../commands/auth-link.js";

describe("runAuthLink() — cross-receiver token selection (Bug 4)", () => {
  let stderrOutput: string;
  let stdoutOutput: string;
  let exitCode: number | undefined;

  beforeEach(() => {
    stderrOutput = "";
    stdoutOutput = "";
    exitCode = undefined;
    vi.spyOn(process.stderr, "write").mockImplementation((msg) => {
      stderrOutput += String(msg);
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation((msg) => {
      stdoutOutput += String(msg);
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation((code) => {
      exitCode = code as number;
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it("errors clearly when URL is passed but no matching credential exists", async () => {
    vi.mocked(loadCredentials).mockReturnValue({
      receiverAuthToken: "cf-token-wrong",
      receivers: {
        cloudflare: { url: "https://cf.workers.dev", authToken: "cf-token-wrong", updatedAt: "" },
      },
    });
    vi.mocked(findReceiverCredentialByUrl).mockReturnValue(undefined);

    await expect(
      runAuthLink({ receiverUrl: "https://3am-receiver.vercel.app" }),
    ).rejects.toThrow("process.exit(1)");

    expect(exitCode).toBe(1);
    expect(stderrOutput).toContain("no stored credentials found");
    expect(stderrOutput).toContain("3am-receiver.vercel.app");
    // Should list available receivers, not silently use wrong token
    expect(stderrOutput).toContain("cloudflare");
  });

  it("does NOT fall through to receiverAuthToken (wrong platform) when URL is provided", async () => {
    // CF token stored as receiverAuthToken (last deploy was CF)
    vi.mocked(loadCredentials).mockReturnValue({
      receiverAuthToken: "cf-token",
      receiverUrl: "https://cf.workers.dev",
      receivers: {
        cloudflare: { url: "https://cf.workers.dev", authToken: "cf-token", updatedAt: "" },
      },
    });
    // URL lookup returns no match (Vercel URL not in map)
    vi.mocked(findReceiverCredentialByUrl).mockReturnValue(undefined);

    await expect(
      runAuthLink({ receiverUrl: "https://3am-receiver.vercel.app" }),
    ).rejects.toThrow("process.exit(1)");

    // createClaimTokenWithRetry should NOT have been called with the wrong CF token
    expect(createClaimTokenWithRetry).not.toHaveBeenCalled();
  });

  it("uses --auth-token flag when provided, bypassing credential lookup", async () => {
    vi.mocked(loadCredentials).mockReturnValue({
      receiverAuthToken: "cf-token-wrong",
    });
    vi.mocked(findReceiverCredentialByUrl).mockReturnValue(undefined);
    vi.mocked(createClaimTokenWithRetry).mockResolvedValue({
      status: "ok",
      token: "claim-tok",
      expiresAt: "2099-01-01T00:00:00Z",
    } as Awaited<ReturnType<typeof createClaimTokenWithRetry>>);

    await runAuthLink({
      receiverUrl: "https://3am-receiver.vercel.app",
      authToken: "explicit-vercel-token",
    });

    expect(createClaimTokenWithRetry).toHaveBeenCalledWith(
      "https://3am-receiver.vercel.app",
      "explicit-vercel-token",
      5,
    );
    expect(exitCode).toBeUndefined();
  });

  it("uses matched receiver token when URL matches a stored receiver", async () => {
    const vercelCred = {
      url: "https://3am-receiver.vercel.app",
      authToken: "vercel-token",
      updatedAt: "",
    };
    vi.mocked(loadCredentials).mockReturnValue({
      receiverAuthToken: "cf-token",
      receivers: {
        vercel: vercelCred,
        cloudflare: { url: "https://cf.workers.dev", authToken: "cf-token", updatedAt: "" },
      },
    });
    vi.mocked(findReceiverCredentialByUrl).mockReturnValue(vercelCred);
    vi.mocked(createClaimTokenWithRetry).mockResolvedValue({
      status: "ok",
      token: "claim-tok",
      expiresAt: "2099-01-01T00:00:00Z",
    } as Awaited<ReturnType<typeof createClaimTokenWithRetry>>);

    await runAuthLink({ receiverUrl: "https://3am-receiver.vercel.app" });

    // Must use the Vercel token, not the CF receiverAuthToken
    expect(createClaimTokenWithRetry).toHaveBeenCalledWith(
      "https://3am-receiver.vercel.app",
      "vercel-token",
      5,
    );
    expect(exitCode).toBeUndefined();
  });

  it("uses legacy receiverAuthToken when NO URL is passed (single-receiver fallback)", async () => {
    vi.mocked(loadCredentials).mockReturnValue({
      receiverUrl: "https://my-receiver.vercel.app",
      receiverAuthToken: "legacy-token",
    });
    vi.mocked(findReceiverCredentialByUrl).mockReturnValue({
      url: "https://my-receiver.vercel.app",
      authToken: "legacy-token",
      updatedAt: "",
    });
    vi.mocked(createClaimTokenWithRetry).mockResolvedValue({
      status: "ok",
      token: "tok",
      expiresAt: "2099-01-01T00:00:00Z",
    } as Awaited<ReturnType<typeof createClaimTokenWithRetry>>);

    await runAuthLink(); // no receiverUrl passed

    expect(createClaimTokenWithRetry).toHaveBeenCalledWith(
      "https://my-receiver.vercel.app",
      "legacy-token",
      5,
    );
    expect(exitCode).toBeUndefined();
  });
});
