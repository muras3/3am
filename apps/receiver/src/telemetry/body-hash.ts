/**
 * Log body normalization and hashing for TelemetryStore dedup.
 *
 * ADR 0032 Appendix A.4: normalize variable parts (UUID, IP, numbers)
 * then SHA-256 hash, truncated to 16 hex chars.
 *
 * Uses Web Crypto API (crypto.subtle) for cross-platform compatibility
 * with Node 18+, Cloudflare Workers, and Vercel Edge.
 */

/**
 * Normalize a log body by replacing variable parts with placeholders.
 *
 * - UUIDs → `<UUID>`
 * - IPv4 addresses → `<IP>`
 * - Numbers → `<NUM>`
 *
 * This ensures structurally identical messages (e.g. same error with
 * different request IDs or IPs) produce the same fingerprint hash.
 */
export function normalizeLogBody(body: string): string {
  return body
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '<UUID>',
    )
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '<IP>')
    .replace(/\b\d+\.?\d*/g, '<NUM>')
}

/**
 * Compute a fingerprint hash for a log body.
 *
 * 1. Normalize the body (replace UUIDs, IPs, numbers)
 * 2. SHA-256 via Web Crypto API
 * 3. Truncate to first 16 hex characters
 *
 * Async because Web Crypto digest is async.
 */
export async function computeBodyHash(body: string): Promise<string> {
  const normalized = normalizeLogBody(body)
  const encoded = new TextEncoder().encode(normalized)
  const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', encoded)
  const hashArray = new Uint8Array(hashBuffer)

  // Convert to hex string and take first 16 chars
  let hex = ''
  for (const byte of hashArray) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex.slice(0, 16)
}
