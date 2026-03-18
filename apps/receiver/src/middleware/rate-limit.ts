import type { MiddlewareHandler } from "hono";

export interface RateLimitOptions {
  /** Time window in milliseconds */
  windowMs: number;
  /** Maximum requests per window per key */
  max: number;
}

/**
 * In-memory sliding window rate limiter.
 * Key: `${clientIP}:${lastPathSegment}` (IP + incident ID for /api/chat/:id).
 */
export function rateLimiter(opts: RateLimitOptions): MiddlewareHandler {
  const store = new Map<string, number[]>();

  return async (c, next) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const segments = c.req.path.split("/");
    const resourceId = segments[segments.length - 1] ?? "unknown";
    const key = `${ip}:${resourceId}`;

    const now = Date.now();
    const cutoff = now - opts.windowMs;
    let timestamps = store.get(key);

    if (timestamps) {
      // Prune expired entries
      const firstValid = timestamps.findIndex((t) => t > cutoff);
      if (firstValid > 0) timestamps.splice(0, firstValid);
      else if (firstValid === -1) timestamps.length = 0;
    } else {
      timestamps = [];
      store.set(key, timestamps);
    }

    if (timestamps.length >= opts.max) {
      return c.json({ error: "too many requests" }, 429);
    }

    timestamps.push(now);
    await next();
  };
}
