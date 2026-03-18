/**
 * Security response header tests.
 * Verifies that all responses include hardening headers.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApp } from "../index.js";

describe("Security response headers", () => {
  let savedEnv: Partial<Record<string, string>>;

  beforeEach(() => {
    savedEnv = {
      ALLOW_INSECURE_DEV_MODE: process.env["ALLOW_INSECURE_DEV_MODE"],
      RECEIVER_AUTH_TOKEN: process.env["RECEIVER_AUTH_TOKEN"],
    };
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
    delete process.env["RECEIVER_AUTH_TOKEN"];
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it("includes all security headers on API responses", async () => {
    process.env["ALLOW_INSECURE_DEV_MODE"] = "true";
    const app = createApp();
    const res = await app.request("/api/incidents");

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'",
    );
  });

  it("does not include security headers on healthz (registered before middleware)", async () => {
    process.env["ALLOW_INSECURE_DEV_MODE"] = "true";
    const app = createApp();
    const res = await app.request("/healthz");

    expect(res.status).toBe(200);
    // healthz is registered before the security headers middleware,
    // so it does NOT get security headers. This is expected — healthz
    // is infra-only and doesn't serve user content.
    expect(res.headers.get("X-Content-Type-Options")).toBeNull();
    expect(res.headers.get("X-Frame-Options")).toBeNull();
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });
});
