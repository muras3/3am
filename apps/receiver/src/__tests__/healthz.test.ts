/**
 * Health check endpoint tests.
 * /healthz is auth-free and CORS-free (infra-only).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApp } from "../index.js";

describe("GET /healthz", () => {
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

  it("returns 200 with status and version", async () => {
    process.env["ALLOW_INSECURE_DEV_MODE"] = "true";
    const app = createApp();
    const res = await app.request("/healthz");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; version: string };
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
  });

  it("does not require auth token", async () => {
    process.env["RECEIVER_AUTH_TOKEN"] = "secret";
    const app = createApp();
    // No Authorization header
    const res = await app.request("/healthz");

    expect(res.status).toBe(200);
  });

  it("does not include CORS headers", async () => {
    process.env["ALLOW_INSECURE_DEV_MODE"] = "true";
    const app = createApp();
    const res = await app.request("/healthz", {
      headers: { Origin: "http://evil.com" },
    });

    expect(res.status).toBe(200);
    // healthz is registered before CORS middleware, so no CORS header
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
