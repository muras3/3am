/**
 * Tests for jwtCookieValidator middleware.
 * Covers both JWT cookie auth (console SPA) and Bearer token auth (API clients).
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { jwtCookieValidator, COOKIE_NAME } from "../../middleware/session-cookie.js";

const AUTH_TOKEN = "test-secret-token";

function buildApp(): Hono {
  const app = new Hono();
  app.use("/protected/*", jwtCookieValidator(AUTH_TOKEN));
  app.get("/protected/resource", (c) => c.json({ ok: true }));
  return app;
}

async function makeJwt(secret: string): Promise<string> {
  return new SignJWT({ sub: "console" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));
}

describe("jwtCookieValidator", () => {
  it("allows request with valid JWT cookie", async () => {
    const app = buildApp();
    const jwt = await makeJwt(AUTH_TOKEN);

    const res = await app.request("/protected/resource", {
      headers: { Cookie: `${COOKIE_NAME}=${jwt}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("allows request with valid Bearer token when no cookie is present", async () => {
    const app = buildApp();

    const res = await app.request("/protected/resource", {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects request with invalid Bearer token and no cookie", async () => {
    const app = buildApp();

    const res = await app.request("/protected/resource", {
      headers: { Authorization: "Bearer wrong-token" },
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects request with no cookie and no Authorization header", async () => {
    const app = buildApp();

    const res = await app.request("/protected/resource");

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
});
