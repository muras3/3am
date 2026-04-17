import { SignJWT, jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";

export const COOKIE_NAME = "console_session";

function getSessionSecret(authToken: string): Uint8Array {
  return new TextEncoder().encode(authToken);
}

async function signSessionJwt(authToken: string): Promise<string> {
  return new SignJWT({ sub: "console" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(getSessionSecret(authToken));
}

export async function issueSessionCookie(
  c: Parameters<MiddlewareHandler>[0],
  opts: { authToken: string; secure: boolean },
): Promise<void> {
  const jwt = await signSessionJwt(opts.authToken);
  setCookie(c, COOKIE_NAME, jwt, {
    httpOnly: true,
    sameSite: "Strict",
    secure: opts.secure,
    path: "/",
  });
}

/** Set JWT session cookie on responses if one is not already present and valid. */
export function jwtCookieSetter(opts: {
  authToken: string;
  secure: boolean;
}): MiddlewareHandler {
  const secret = getSessionSecret(opts.authToken);

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
      await issueSessionCookie(c, opts);
    }

    await next();
  };
}

/** Reject requests without a valid JWT session cookie or Bearer token. */
export function jwtCookieValidator(authToken: string): MiddlewareHandler {
  const secret = getSessionSecret(authToken);

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

/** Accept either a valid session cookie or the raw Bearer token. */
export function sessionOrBearerAuth(authToken: string): MiddlewareHandler {
  const secret = getSessionSecret(authToken);

  return async (c, next) => {
    const token = getCookie(c, COOKIE_NAME);
    if (token) {
      try {
        await jwtVerify(token, secret);
        return await next();
      } catch {
        // Fall through to Bearer auth for API clients that also send a token.
      }
    }

    const authHeader = c.req.header("Authorization");
    if (authHeader === `Bearer ${authToken}`) {
      return await next();
    }

    return c.json({ error: "unauthorized" }, 401);
  };
}
