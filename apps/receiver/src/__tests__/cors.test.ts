/**
 * CORS middleware tests (ADR 0019 v2, Task 5).
 *
 * Verifies CORS behaviour across three modes:
 * - Dev mode (ALLOW_INSECURE_DEV_MODE=true)  → Access-Control-Allow-Origin: *
 * - Prod with CORS_ALLOWED_ORIGIN configured  → origin reflected
 * - Prod with no CORS env var                → no CORS header (same-origin only)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApp } from "../index.js";

const ENV_KEYS = ["RECEIVER_AUTH_TOKEN", "CORS_ALLOWED_ORIGIN", "ALLOW_INSECURE_DEV_MODE"] as const;

describe("CORS middleware", () => {
  let savedEnv: Partial<Record<string, string>>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it("dev mode sets Access-Control-Allow-Origin: *", async () => {
    process.env["ALLOW_INSECURE_DEV_MODE"] = "true";

    const app = createApp();
    const res = await app.request("/api/incidents", {
      headers: { Origin: "http://localhost:5173" },
    });

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("CORS_ALLOWED_ORIGIN reflects the configured origin", async () => {
    process.env["RECEIVER_AUTH_TOKEN"] = "test-token";
    process.env["CORS_ALLOWED_ORIGIN"] = "https://app.example.com";

    const app = createApp();
    const res = await app.request("/api/incidents", {
      headers: { Origin: "https://app.example.com" },
    });

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
  });

  it("no CORS header when CORS_ALLOWED_ORIGIN is unset in prod", async () => {
    process.env["RECEIVER_AUTH_TOKEN"] = "test-token";
    // CORS_ALLOWED_ORIGIN deliberately not set

    const app = createApp();
    const res = await app.request("/api/incidents", {
      headers: { Origin: "https://evil.com" },
    });

    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("OPTIONS preflight returns CORS headers in dev mode", async () => {
    process.env["ALLOW_INSECURE_DEV_MODE"] = "true";

    const app = createApp();
    const res = await app.request("/api/incidents", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const allowMethods = res.headers.get("Access-Control-Allow-Methods");
    expect(allowMethods).not.toBeNull();
    expect(allowMethods).toMatch(/GET/i);
    expect(allowMethods).toMatch(/POST/i);
  });
});
