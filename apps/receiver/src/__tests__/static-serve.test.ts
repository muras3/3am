/**
 * Static serving tests (E4).
 *
 * Verifies that Receiver serves the Console SPA when consoleDist is configured,
 * and that auth scoping is correct (ADR 0028):
 * - /v1/*           → 401 without Bearer
 * - /api/diagnosis/* → 401 without Bearer
 * - /api/*           → 200 without Bearer (same-origin Console routes)
 * - /               → index.html (static SPA)
 * - /unknown-route  → index.html (SPA fallback)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createApp } from "../index.js";

const MOCK_HTML = "<!DOCTYPE html><html><body>Console</body></html>";
const TOKEN = "test-static-token";

let consoleDist: string;

beforeAll(() => {
  consoleDist = mkdtempSync(join(tmpdir(), "3amoncall-static-test-"));
  mkdirSync(join(consoleDist, "assets"), { recursive: true });
  writeFileSync(join(consoleDist, "index.html"), MOCK_HTML);
  writeFileSync(join(consoleDist, "assets", "app.js"), "console.log('app')");
  process.env["RECEIVER_AUTH_TOKEN"] = TOKEN;
});

afterAll(() => {
  rmSync(consoleDist, { recursive: true, force: true });
  delete process.env["RECEIVER_AUTH_TOKEN"];
});

function makeApp() {
  return createApp(undefined, { consoleDist });
}

describe("Receiver static serving (E4)", () => {
  it("GET / returns index.html", async () => {
    const app = makeApp();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Console");
  });

  it("GET /assets/app.js returns the static file", async () => {
    const app = makeApp();
    const res = await app.request("/assets/app.js");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("console.log");
  });

  it("GET /some/unknown/path returns index.html (SPA fallback)", async () => {
    const app = makeApp();
    const res = await app.request("/some/unknown/path");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Console");
  });

  it("GET /api/incidents returns 200 without Bearer (same-origin Console route)", async () => {
    const app = makeApp();
    const res = await app.request("/api/incidents");
    expect(res.status).toBe(200);
  });

  it("POST /api/diagnosis/:id returns 401 without Bearer (GitHub Actions route)", async () => {
    const app = makeApp();
    const res = await app.request("/api/diagnosis/inc_test", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("POST /api/diagnosis/:id returns non-401 with Bearer (GitHub Actions route authenticated)", async () => {
    const app = makeApp();
    const res = await app.request("/api/diagnosis/inc_nonexistent", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    // 400 (bad body) means auth passed
    expect(res.status).not.toBe(401);
  });

  it("POST /v1/traces returns 401 without Bearer (ingest route)", async () => {
    const app = makeApp();
    const res = await app.request("/v1/traces", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("POST /v1/traces returns non-401 with Bearer (ingest route authenticated)", async () => {
    const app = makeApp();
    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    // 400 (missing field) means auth passed
    expect(res.status).not.toBe(401);
  });
});
