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
  checkReceiver,
  waitForReceiver,
  fetchSetupToken,
  fetchSetupTokenWithRetry,
  type SetupTokenResult,
} from "../commands/shared/health.js";

/** Flush all pending microtasks (Promise callbacks) */
function _flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// checkReceiver
// ---------------------------------------------------------------------------

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
    const result = await checkReceiver("http://localhost:3333");
    expect(result).toBe(true);
  });

  it("returns false when fetch responds with 500", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("error", { status: 500 }));
    const result = await checkReceiver("http://localhost:3333");
    expect(result).toBe(false);
  });

  it("returns false when fetch throws (network error)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await checkReceiver("http://localhost:3333");
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// waitForReceiver
// ---------------------------------------------------------------------------

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

  it("returns true immediately when the first check succeeds", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));

    const promise = waitForReceiver("http://localhost:3333", 10_000, 3_000);
    // Flush pending microtasks, then advance timers to allow the function to resolve
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(result).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("returns true after retry when first call fails and second succeeds", async () => {
    globalThis.fetch = (vi.fn() as MockedFunction<typeof fetch>)
      .mockResolvedValueOnce(new Response("error", { status: 500 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const promise = waitForReceiver("http://localhost:3333", 10_000, 3_000);

    // First check completes (500), then we advance past the polling interval
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await promise;

    expect(result).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("returns false when all calls fail within the timeout", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("error", { status: 500 }));

    const promise = waitForReceiver("http://localhost:3333", 6_000, 3_000);

    // Advance past the full timeout (covers multiple polling cycles)
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await promise;

    expect(result).toBe(false);
  });

  it("respects the polling interval between retries", async () => {
    const callTimes: number[] = [];
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callTimes.push(Date.now());
      return new Response("error", { status: 500 });
    });

    const INTERVAL_MS = 5_000;
    const promise = waitForReceiver("http://localhost:3333", 12_000, INTERVAL_MS);

    // Advance past two intervals to get at least 2 calls
    await vi.advanceTimersByTimeAsync(12_000);
    await promise;

    expect(callTimes.length).toBeGreaterThanOrEqual(2);
    // The gap between first and second call should be approximately INTERVAL_MS
    if (callTimes.length >= 2) {
      const gap = callTimes[1]! - callTimes[0]!;
      expect(gap).toBeGreaterThanOrEqual(INTERVAL_MS - 100);
    }
  });
});

// ---------------------------------------------------------------------------
// fetchSetupToken
// ---------------------------------------------------------------------------

describe("fetchSetupToken()", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns token when setup is not complete and token is available", async () => {
    globalThis.fetch = (vi.fn() as MockedFunction<typeof fetch>)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ setupComplete: false }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "abc" }), { status: 200 }),
      );

    const result = await fetchSetupToken("http://localhost:3333");
    expect(result).toEqual({ status: "token", token: "abc" });
  });

  it("returns already-setup when setup is already complete", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ setupComplete: true }), { status: 200 }),
      );

    const result = await fetchSetupToken("http://localhost:3333");
    expect(result).toEqual({ status: "already-setup" });
    // Should NOT call setup-token
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("returns already-setup when setup-token returns 403 (race condition)", async () => {
    globalThis.fetch = (vi.fn() as MockedFunction<typeof fetch>)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ setupComplete: false }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response("Forbidden", { status: 403 }));

    const result = await fetchSetupToken("http://localhost:3333");
    expect(result).toEqual({ status: "already-setup" });
  });

  it("returns retryable error when setup-status returns 401 (DB not ready)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401 }),
    );

    const result = await fetchSetupToken("http://localhost:3333");
    expect(result).toEqual({
      status: "error",
      message: "setup-status returned 401",
      retryable: true,
    });
  });

  it("returns retryable error when setup-status returns 503", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response("Service Unavailable", { status: 503 }),
    );

    const result = await fetchSetupToken("http://localhost:3333");
    expect(result).toEqual({
      status: "error",
      message: "setup-status returned 503",
      retryable: true,
    });
  });

  it("returns non-retryable error when setup-status returns 500", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );

    const result = await fetchSetupToken("http://localhost:3333");
    expect(result).toEqual({
      status: "error",
      message: "setup-status returned 500",
      retryable: false,
    });
  });

  it("returns retryable error when setup-status fetch throws (network)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await fetchSetupToken("http://localhost:3333");
    expect(result.status).toBe("error");
    expect((result as { status: "error"; message: string }).message).toContain(
      "setup-status",
    );
    expect((result as { status: "error"; retryable?: boolean }).retryable).toBe(true);
  });

  it("returns error when setup-token fetch throws", async () => {
    globalThis.fetch = (vi.fn() as MockedFunction<typeof fetch>)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ setupComplete: false }), { status: 200 }),
      )
      .mockRejectedValueOnce(new Error("network failure"));

    const result = await fetchSetupToken("http://localhost:3333");
    expect(result.status).toBe("error");
    expect((result as { status: "error"; message: string }).message).toContain(
      "setup-token",
    );
  });
});

// ---------------------------------------------------------------------------
// fetchSetupTokenWithRetry
// ---------------------------------------------------------------------------

describe("fetchSetupTokenWithRetry()", () => {
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

  it("returns immediately on success (no retries needed)", async () => {
    globalThis.fetch = (vi.fn() as MockedFunction<typeof fetch>)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ setupComplete: false }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "tok" }), { status: 200 }),
      );

    const promise = fetchSetupTokenWithRetry("http://localhost:3333", 3);
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(result).toEqual({ status: "token", token: "tok" });
    // setup-status + setup-token = 2 fetch calls total, no retries
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("returns immediately on non-retryable error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Internal Server Error", { status: 500 }),
    );

    const onRetry = vi.fn();
    const promise = fetchSetupTokenWithRetry("http://localhost:3333", 3, onRetry);
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(result.status).toBe("error");
    expect((result as { retryable?: boolean }).retryable).toBe(false);
    // Only 1 fetch call — no retry for non-retryable errors
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("retries on 401 and succeeds on second attempt", async () => {
    globalThis.fetch = (vi.fn() as MockedFunction<typeof fetch>)
      // Attempt 1: setup-status returns 401
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))
      // Attempt 2: setup-status OK, setup-token OK
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ setupComplete: false }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "tok" }), { status: 200 }),
      );

    const onRetry = vi.fn();
    const promise = fetchSetupTokenWithRetry("http://localhost:3333", 3, onRetry);

    // First attempt resolves immediately, then needs to wait for backoff
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await promise;

    expect(result).toEqual({ status: "token", token: "tok" });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, 3, 3_000, "setup-status returned 401");
  });

  it("retries on network error and succeeds after multiple retries", async () => {
    globalThis.fetch = (vi.fn() as MockedFunction<typeof fetch>)
      // Attempt 1: network error
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      // Attempt 2: still 401
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))
      // Attempt 3: success
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ setupComplete: false }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "tok" }), { status: 200 }),
      );

    const onRetry = vi.fn();
    const promise = fetchSetupTokenWithRetry("http://localhost:3333", 5, onRetry);

    // Advance through both backoff delays (3s + 6s)
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await promise;

    expect(result).toEqual({ status: "token", token: "tok" });
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("returns error after all retries exhausted", async () => {
    // All attempts return 401
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    );

    const onRetry = vi.fn();
    const promise = fetchSetupTokenWithRetry("http://localhost:3333", 3, onRetry);

    // Advance through all backoff delays: 3s + 6s
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await promise;

    expect(result.status).toBe("error");
    expect((result as { message: string }).message).toContain("401");
    // 2 retries logged (attempts 1 and 2 retry; attempt 3 is last, no retry)
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("returns already-setup without retries", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ setupComplete: true }), { status: 200 }),
    );

    const onRetry = vi.fn();
    const promise = fetchSetupTokenWithRetry("http://localhost:3333", 3, onRetry);
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(result).toEqual({ status: "already-setup" });
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("uses exponential backoff capped at 15s", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    );

    const delays: number[] = [];
    const onRetry = (_a: number, _m: number, d: number) => { delays.push(d); };
    const promise = fetchSetupTokenWithRetry("http://localhost:3333", 5, onRetry);

    // Advance enough time for all retries
    await vi.advanceTimersByTimeAsync(60_000);
    await promise;

    // Expected delays: 3000, 6000, 12000, 15000 (capped)
    expect(delays).toEqual([3_000, 6_000, 12_000, 15_000]);
  });
});
