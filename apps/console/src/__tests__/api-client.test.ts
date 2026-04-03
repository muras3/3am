import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  apiFetch as ApiFetchType,
  apiFetchPost as ApiFetchPostType,
  ApiError as ApiErrorType,
  AUTH_FAILURE_EVENT as AuthFailureEventType,
  saveAuthToken as SaveAuthTokenType,
} from "../api/client.js";

describe("apiFetch", () => {
  let apiFetch: typeof ApiFetchType;
  let apiFetchPost: typeof ApiFetchPostType;
  let ApiError: typeof ApiErrorType;
  let AUTH_FAILURE_EVENT: typeof AuthFailureEventType;
  let saveAuthToken: typeof SaveAuthTokenType;

  beforeEach(async () => {
    localStorage.clear();
    // Re-import to pick up fresh module state
    const mod = await import("../api/client.js");
    apiFetch = mod.apiFetch;
    apiFetchPost = mod.apiFetchPost;
    ApiError = mod.ApiError;
    AUTH_FAILURE_EVENT = mod.AUTH_FAILURE_EVENT;
    saveAuthToken = mod.saveAuthToken;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("returns parsed JSON on success", async () => {
    const mockData = { items: [], nextCursor: undefined };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockData),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await apiFetch<typeof mockData>("/api/incidents");
    expect(result).toEqual(mockData);
    expect(mockFetch).toHaveBeenCalledWith("/api/incidents", {
      headers: expect.objectContaining({
        "Content-Type": "application/json",
      }),
    });
  });

  it("throws ApiError with correct status on non-2xx response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Not Found"),
    });
    vi.stubGlobal("fetch", mockFetch);

    // message is the user-friendly string; rawBody holds the original response
    await expect(apiFetch("/api/incidents/unknown")).rejects.toThrow("Not found.");
    try {
      await apiFetch("/api/incidents/unknown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as InstanceType<typeof ApiError>).status).toBe(404);
      expect((err as InstanceType<typeof ApiError>).rawBody).toBe("Not Found");
    }
  });

  it("sends Authorization header when token is stored", async () => {
    saveAuthToken("my-secret-token");
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", mockFetch);

    await apiFetch("/api/test");

    const calledHeaders = mockFetch.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(calledHeaders["Authorization"]).toBe("Bearer my-secret-token");
  });

  it("does not send Authorization header when no token is stored", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", mockFetch);

    await apiFetch("/api/test");

    const calledHeaders = mockFetch.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(calledHeaders["Authorization"]).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Auth failure (401/403) handling
  // ---------------------------------------------------------------------------

  describe("auth failure handling", () => {
    it("clears localStorage token on 401 and dispatches AUTH_FAILURE_EVENT", async () => {
      saveAuthToken("stale-token");
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      });
      vi.stubGlobal("fetch", mockFetch);

      const events: Event[] = [];
      const handler = (e: Event) => events.push(e);
      window.addEventListener(AUTH_FAILURE_EVENT, handler);

      await expect(apiFetch("/api/incidents")).rejects.toThrow("Unauthorized.");

      expect(localStorage.getItem("receiver_auth_token")).toBeNull();
      expect(events).toHaveLength(1);

      window.removeEventListener(AUTH_FAILURE_EVENT, handler);
    });

    it("clears localStorage token on 403", async () => {
      saveAuthToken("stale-token");
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: () => Promise.resolve("Forbidden"),
      });
      vi.stubGlobal("fetch", mockFetch);

      await expect(apiFetch("/api/incidents")).rejects.toThrow("Unauthorized.");
      expect(localStorage.getItem("receiver_auth_token")).toBeNull();
    });

    it("does NOT clear token on non-auth errors (404, 500)", async () => {
      saveAuthToken("valid-token");
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Error"),
      });
      vi.stubGlobal("fetch", mockFetch);

      await expect(apiFetch("/api/incidents")).rejects.toThrow();
      expect(localStorage.getItem("receiver_auth_token")).toBe("valid-token");
    });

    it("apiFetchPost also triggers auth failure on 401", async () => {
      saveAuthToken("stale-token");
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      });
      vi.stubGlobal("fetch", mockFetch);

      const events: Event[] = [];
      const handler = (e: Event) => events.push(e);
      window.addEventListener(AUTH_FAILURE_EVENT, handler);

      await expect(apiFetchPost("/api/query", { q: "test" })).rejects.toThrow("Unauthorized.");

      expect(localStorage.getItem("receiver_auth_token")).toBeNull();
      expect(events).toHaveLength(1);

      window.removeEventListener(AUTH_FAILURE_EVENT, handler);
    });

    // -----------------------------------------------------------------------
    // Stale-401 race guard
    // -----------------------------------------------------------------------

    it("does NOT clear token when a new token was saved between request and response", async () => {
      saveAuthToken("old-token");

      // Simulate: fetch is called with old-token, but before it resolves
      // the user enters a new token
      const mockFetch = vi.fn().mockImplementation(() => {
        // Between request start and response, user enters new token
        saveAuthToken("new-token");
        return Promise.resolve({
          ok: false,
          status: 401,
          text: () => Promise.resolve("Unauthorized"),
        });
      });
      vi.stubGlobal("fetch", mockFetch);

      const events: Event[] = [];
      const handler = (e: Event) => events.push(e);
      window.addEventListener(AUTH_FAILURE_EVENT, handler);

      await expect(apiFetch("/api/incidents")).rejects.toThrow("Unauthorized.");

      // The new token should NOT be cleared
      expect(localStorage.getItem("receiver_auth_token")).toBe("new-token");
      // No auth failure event should be dispatched (token was already replaced)
      expect(events).toHaveLength(0);

      window.removeEventListener(AUTH_FAILURE_EVENT, handler);
    });

    it("clears token when the same token is still present at response time", async () => {
      saveAuthToken("same-token");

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      });
      vi.stubGlobal("fetch", mockFetch);

      await expect(apiFetch("/api/incidents")).rejects.toThrow("Unauthorized.");

      // Token was not replaced, so it should be cleared
      expect(localStorage.getItem("receiver_auth_token")).toBeNull();
    });
  });
});
