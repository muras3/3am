import type { MiddlewareHandler } from "hono";
import type { StorageDriver } from "../storage/interface.js";

export interface RateLimitOptions {
  /** Time window in milliseconds */
  windowMs: number;
  /** Maximum requests per window per key */
  max: number;
  storage: StorageDriver;
}

/**
 * Shared fixed-window rate limiter.
 * Key: `${clientIP}:${lastPathSegment}` (IP + incident ID for /api/chat/:id).
 */
export function rateLimiter(opts: RateLimitOptions): MiddlewareHandler {
  return async (c, next) => {
    const ip =
      c.req.header("cf-connecting-ip") ??
      c.req.header("x-real-ip") ??
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      "unknown";
    const segments = c.req.path.split("/");
    const resourceId = segments[segments.length - 1] ?? "unknown";
    const key = `${ip}:${resourceId}`;

    const allowed = await opts.storage.consumeRateLimit(key, opts.windowMs, opts.max);
    if (!allowed) {
      return c.json({ error: "too many requests" }, 429);
    }

    await next();
  };
}
