import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendWebhook } from "../webhook.js";

const TEST_URL = "https://hooks.slack.com/services/T123/B456/secret-token-here";

function makeFetchResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

describe("sendWebhook", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok: true with status 200 on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeFetchResponse(200)));
    const result = await sendWebhook(TEST_URL, { event: "test" });
    expect(result).toEqual({ ok: true, status: 200 });
    vi.unstubAllGlobals();
  });

  it("returns ok: true with status 204 on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeFetchResponse(204)));
    const result = await sendWebhook(TEST_URL, { event: "test" });
    expect(result).toEqual({ ok: true, status: 204 });
    vi.unstubAllGlobals();
  });

  it("returns ok: false with status 400 on client error and does NOT retry", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeFetchResponse(400));
    vi.stubGlobal("fetch", mockFetch);
    const result = await sendWebhook(TEST_URL, { event: "test" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("returns ok: true after retry when first 500 then 200", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeFetchResponse(500))
      .mockResolvedValueOnce(makeFetchResponse(200));
    vi.stubGlobal("fetch", mockFetch);
    const result = await sendWebhook(TEST_URL, { event: "test" });
    expect(result).toEqual({ ok: true, status: 200 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("returns ok: false after two consecutive 500 responses", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse(500));
    vi.stubGlobal("fetch", mockFetch);
    const result = await sendWebhook(TEST_URL, { event: "test" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("returns ok: false when fetch throws a network TypeError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const result = await sendWebhook(TEST_URL, { event: "test" });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("returns ok: false when fetch throws an AbortError (timeout)", async () => {
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError));
    const result = await sendWebhook(TEST_URL, { event: "test" });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("calls console.warn on failure containing the hostname but not the full URL", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeFetchResponse(400)));
    await sendWebhook(TEST_URL, { event: "test" });
    const warnCalls = (console.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(warnCalls.length).toBeGreaterThan(0);
    const warnText = warnCalls.flat().join(" ");
    expect(warnText).toContain("hooks.slack.com");
    vi.unstubAllGlobals();
  });

  it("does NOT include the webhook secret token portion in console.warn output", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeFetchResponse(500)));
    await sendWebhook(TEST_URL, { event: "test" });
    const warnCalls = (console.warn as ReturnType<typeof vi.fn>).mock.calls;
    const warnText = warnCalls.flat().join(" ");
    // The path segment with the secret token must not appear
    expect(warnText).not.toContain("secret-token-here");
    expect(warnText).not.toContain("/services/T123/B456/secret-token-here");
    vi.unstubAllGlobals();
  });
});
