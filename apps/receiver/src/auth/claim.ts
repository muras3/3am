import type { StorageDriver } from "../storage/interface.js";

/** Prefix for all claim storage keys. */
export const CLAIM_KEY_PREFIX = "claim:";

/** Default TTL for deploy/setup claim links (10 minutes). */
export const DEPLOY_CLAIM_TTL_MS = 10 * 60 * 1000;

/** TTL for notification claim links (5 hours) — on-call may not check immediately. */
export const NOTIFICATION_CLAIM_TTL_MS = 5 * 60 * 60 * 1000;

export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * Mint a claim token and persist it in storage.
 *
 * The caller specifies the TTL so the same function serves both
 * deploy-time (10 min) and notification (5 h) use cases.
 *
 * Returns the raw token (for embedding in URLs) and its expiry.
 */
export async function mintClaimToken(
  storage: StorageDriver,
  ttlMs: number,
): Promise<{ token: string; expiresAt: string }> {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = base64UrlEncode(tokenBytes);
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const tokenHash = await sha256(token);

  await storage.setSettings(
    CLAIM_KEY_PREFIX + tokenHash,
    JSON.stringify({ expiresAt }),
  );

  return { token, expiresAt };
}
