import { SignJWT, jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";

export const COOKIE_NAME = "console_session";

/** Set JWT session cookie on responses if one is not already present and valid. */
export function jwtCookieSetter(opts: {
  authToken: string;
  secure: boolean;
}): MiddlewareHandler {
  const secret = new TextEncoder().encode(opts.authToken);

  return async (c, next) => {
    const existing = getCookie(c, COOKIE_NAME);
    let needsCookie = true;

    if (existing) {
      try {
        await jwtVerify(existing, secret);
        needsCookie = false;
      } catch {
        // invalid or expired — will issue a new one
      }
    }

    if (needsCookie) {
      const jwt = await new SignJWT({ sub: "console" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("24h")
        .sign(secret);
      setCookie(c, COOKIE_NAME, jwt, {
        httpOnly: true,
        sameSite: "Strict",
        secure: opts.secure,
        path: "/",
      });
    }

    await next();
  };
}

/** Reject requests without a valid JWT session cookie or Bearer token. */
export function jwtCookieValidator(authToken: string): MiddlewareHandler {
  const secret = new TextEncoder().encode(authToken);

  return async (c, next) => {
    const cookie = getCookie(c, COOKIE_NAME);
    if (cookie) {
      try {
        await jwtVerify(cookie, secret);
        return await next();
      } catch {
        return c.json({ error: "unauthorized" }, 401);
      }
    }

    // Fallback: Bearer token (raw string comparison) for API clients (CLI, curl)
    const authHeader = c.req.header("Authorization");
    if (authHeader === `Bearer ${authToken}`) {
      return await next();
    }

    return c.json({ error: "unauthorized" }, 401);
  };
}
