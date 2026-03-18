import { randomBytes } from "crypto";
import type { MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const GC_INTERVAL_MS = 60_000;
export const COOKIE_NAME = "console_session";

export class SessionStore {
  private sessions = new Map<string, number>(); // token → expiresAt
  private lastGc = Date.now();

  create(): string {
    this.gc();
    const token = randomBytes(32).toString("hex");
    this.sessions.set(token, Date.now() + SESSION_TTL_MS);
    return token;
  }

  validate(token: string): boolean {
    const expiresAt = this.sessions.get(token);
    if (expiresAt === undefined) return false;
    if (Date.now() > expiresAt) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  private gc(): void {
    const now = Date.now();
    if (now - this.lastGc < GC_INTERVAL_MS) return;
    this.lastGc = now;
    for (const [token, expiresAt] of this.sessions) {
      if (now > expiresAt) this.sessions.delete(token);
    }
  }
}

/** Set session cookie on responses if one is not already present and valid. */
export function sessionCookieSetter(
  store: SessionStore,
  opts: { secure: boolean },
): MiddlewareHandler {
  return async (c, next) => {
    const existing = getCookie(c, COOKIE_NAME);
    if (!existing || !store.validate(existing)) {
      const token = store.create();
      setCookie(c, COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: "Strict",
        secure: opts.secure,
        path: "/",
      });
    }
    await next();
  };
}

/** Reject requests without a valid session cookie. */
export function sessionCookieValidator(store: SessionStore): MiddlewareHandler {
  return async (c, next) => {
    const token = getCookie(c, COOKIE_NAME);
    if (!token || !store.validate(token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}
