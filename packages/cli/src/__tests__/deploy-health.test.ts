import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockedFunction,
} from "vitest";
import {
  buildClaimUrl,
  checkReceiver,
  createClaimToken,
  createClaimTokenWithRetry,
  waitForReceiver,
} from "../commands/shared/health.js";

describe("checkReceiver()", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns true when fetch responds with 200", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await expect(checkReceiver("http://localhost:3333")).resolves.toBe(true);
  });

  it("returns false when fetch throws", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(checkReceiver("http://localhost:3333")).resolves.toBe(false);
  });
});

describe("waitForReceiver()", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("returns true after a retry", async () => {
    globalThis.fetch = (vi.fn() as MockedFunction<typeof fetch>)
      .mockResolvedValueOnce(new Response("nope", { status: 500 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const promise = waitForReceiver("http://localhost:3333", 10_000, 3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(promise).resolves.toBe(true);
  });
});

describe("createClaimToken()", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns a token and expiry on success", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ token: "abc", expiresAt: "2026-04-01T00:00:00.000Z" }), { status: 200 }),
    );

    await expect(createClaimToken("http://localhost:3333", "secret")).resolves.toEqual({
      status: "ok",
      token: "abc",
      expiresAt: "2026-04-01T00:00:00.000Z",
    });
  });

  it("marks 401 as retryable", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));

    await expect(createClaimToken("http://localhost:3333", "secret")).resolves.toEqual({
      status: "error",
      message: "claims returned 401",
      retryable: true,
    });
  });
});

describe("createClaimTokenWithRetry()", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries retryable failures and eventually succeeds", async () => {
    globalThis.fetch = (vi.fn() as MockedFunction<typeof fetch>)
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "claim-token", expiresAt: "2026-04-01T00:00:00.000Z" }), { status: 200 }),
      );

    const onRetry = vi.fn();
    const promise = createClaimTokenWithRetry("http://localhost:3333", "secret", 3, onRetry);
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(promise).resolves.toEqual({
      status: "ok",
      token: "claim-token",
      expiresAt: "2026-04-01T00:00:00.000Z",
    });
    expect(onRetry).toHaveBeenCalledWith(1, 3, 3_000, "claims returned 401");
  });
});

describe("buildClaimUrl()", () => {
  it("embeds the claim token in the URL hash", () => {
    expect(buildClaimUrl("https://example.com", "abc123")).toBe("https://example.com/#claim=abc123");
  });
});
