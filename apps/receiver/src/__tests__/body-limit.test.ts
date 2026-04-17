/**
 * Body size limit tests for API POST endpoints (B-13).
 * Verifies that oversized payloads are rejected with 413.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryAdapter } from "../storage/adapters/memory.js";
import { createApp } from "../index.js";

describe("API body limits (B-13)", () => {
  let savedEnv: Partial<Record<string, string>>;

  beforeEach(() => {
    savedEnv = {
      ALLOW_INSECURE_DEV_MODE: process.env["ALLOW_INSECURE_DEV_MODE"],
      RECEIVER_AUTH_TOKEN: process.env["RECEIVER_AUTH_TOKEN"],
    };
    process.env["ALLOW_INSECURE_DEV_MODE"] = "true";
    delete process.env["RECEIVER_AUTH_TOKEN"];
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it("POST /api/chat/:id rejects body > 1KB with 413", async () => {
    const store = new MemoryAdapter();
    const app = createApp(store);
    const oversizedBody = JSON.stringify({ message: "x".repeat(2048) });

    const res = await app.request("/api/chat/inc_test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(oversizedBody)),
      },
      body: oversizedBody,
    });

    expect(res.status).toBe(413);
  });

  it("POST /api/diagnosis/:id rejects body > 512KB with 413", async () => {
    const store = new MemoryAdapter();
    const app = createApp(store);
    // 600KB payload — exceeds 512KB limit
    const oversizedBody = JSON.stringify({ data: "x".repeat(600 * 1024) });

    const res = await app.request("/api/diagnosis/inc_test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(oversizedBody)),
      },
      body: oversizedBody,
    });

    expect(res.status).toBe(413);
  });

  it("POST /api/diagnosis/:id allows body under 512KB", async () => {
    const store = new MemoryAdapter();
    const app = createApp(store);
    // Valid but small body (will fail validation, but should NOT be 413)
    const body = JSON.stringify({ data: "small" });

    const res = await app.request("/api/diagnosis/inc_test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    // 400 = validation error (not a valid DiagnosisResult), but not 413
    expect(res.status).not.toBe(413);
  });
});
