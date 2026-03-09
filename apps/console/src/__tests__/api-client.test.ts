import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { apiFetch as ApiFetchType, ApiError as ApiErrorType } from "../api/client.js";

describe("apiFetch", () => {
  let apiFetch: typeof ApiFetchType;
  let ApiError: typeof ApiErrorType;

  beforeEach(async () => {
    // Re-import to pick up fresh module state
    const mod = await import("../api/client.js");
    apiFetch = mod.apiFetch;
    ApiError = mod.ApiError;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

  it("does not set Authorization header — auth is same-origin server-side only (ADR 0028)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", mockFetch);

    await apiFetch("/api/test");

    const calledHeaders = mockFetch.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(calledHeaders["Content-Type"]).toBe("application/json");
    expect(calledHeaders["Authorization"]).toBeUndefined();
  });
});
