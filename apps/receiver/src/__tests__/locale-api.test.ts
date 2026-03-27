/**
 * Integration tests for locale settings API endpoints.
 * GET /api/settings/locale and PUT /api/settings/locale.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryAdapter } from "../storage/adapters/memory.js";
import { createApp } from "../index.js";

describe("Locale settings API", () => {
  let savedEnv: Partial<Record<string, string>>;

  beforeEach(() => {
    savedEnv = {
      ALLOW_INSECURE_DEV_MODE: process.env["ALLOW_INSECURE_DEV_MODE"],
      RECEIVER_AUTH_TOKEN: process.env["RECEIVER_AUTH_TOKEN"],
    };
    // Run in insecure dev mode so no auth is needed
    process.env["ALLOW_INSECURE_DEV_MODE"] = "true";
    delete process.env["RECEIVER_AUTH_TOKEN"];
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it("GET /api/settings/locale returns 'en' by default", async () => {
    const app = createApp(new MemoryAdapter());
    const res = await app.request("/api/settings/locale");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { locale: string };
    expect(body.locale).toBe("en");
  });

  it("PUT /api/settings/locale sets locale to 'ja'", async () => {
    const app = createApp(new MemoryAdapter());
    const res = await app.request("/api/settings/locale", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: "ja" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { locale: string };
    expect(body.locale).toBe("ja");
  });

  it("GET reflects locale after PUT", async () => {
    const app = createApp(new MemoryAdapter());

    await app.request("/api/settings/locale", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: "ja" }),
    });

    const res = await app.request("/api/settings/locale");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { locale: string };
    expect(body.locale).toBe("ja");
  });

  it("PUT with invalid locale returns 400", async () => {
    const app = createApp(new MemoryAdapter());
    const res = await app.request("/api/settings/locale", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: "fr" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("locale must be one of");
  });

  it("PUT with missing locale returns 400", async () => {
    const app = createApp(new MemoryAdapter());
    const res = await app.request("/api/settings/locale", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("PUT with invalid body returns 400", async () => {
    const app = createApp(new MemoryAdapter());
    const res = await app.request("/api/settings/locale", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("PUT 'en' works after setting 'ja'", async () => {
    const app = createApp(new MemoryAdapter());

    await app.request("/api/settings/locale", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: "ja" }),
    });

    const res = await app.request("/api/settings/locale", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: "en" }),
    });
    expect(res.status).toBe(200);

    const getRes = await app.request("/api/settings/locale");
    const body = (await getRes.json()) as { locale: string };
    expect(body.locale).toBe("en");
  });
});
