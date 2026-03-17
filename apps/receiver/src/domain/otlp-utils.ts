/**
 * Shared OTLP payload parsing utilities.
 *
 * Used by anomaly-detector.ts and evidence-extractor.ts to parse
 * the decoded (JSON-like) OTLP structure.
 */

/** Type guard: plain object (not null, not array). */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Type guard: array. */
export function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v)
}

/**
 * Convert a nanosecond timestamp (string, number, or unknown) to milliseconds.
 * Returns null for missing/zero values so callers can decide how to handle them.
 */
const NANO_PER_MS = BigInt(1_000_000)

export function nanoToMs(nano: unknown): number | null {
  if (nano === undefined || nano === null || nano === '0' || nano === 0) return null
  try {
    const n = typeof nano === 'string' ? BigInt(nano) : BigInt(String(nano))
    return Number(n / NANO_PER_MS)
  } catch {
    // Non-integer or non-numeric string: treat as missing rather than throwing
    return null
  }
}

/**
 * Extract a string attribute value from an OTLP attributes array.
 * Only matches attributes where value.stringValue is a string.
 * Returns '' if the key is not found or the value is not a stringValue.
 */
export function getStringAttr(attrs: unknown, key: string): string {
  if (!isArray(attrs)) return ''
  for (const attr of attrs) {
    if (!isRecord(attr)) continue
    if (attr['key'] !== key) continue
    const val = attr['value']
    if (isRecord(val) && typeof val['stringValue'] === 'string') {
      return val['stringValue']
    }
  }
  return ''
}

/**
 * Normalize a traceId/spanId value to lowercase hex.
 *
 * OTLP JSON transport uses lowercase hex strings. OTLP protobuf transport
 * (via protobufjs with `bytes: String`) returns base64-encoded strings.
 * This helper detects the encoding and normalizes to hex.
 *
 * Detection: if the value consists entirely of hex characters, it is already hex.
 * Otherwise, assume base64 and convert.
 *
 * Returns '' for non-string or empty values.
 */
const HEX_PATTERN = /^[0-9a-f]+$/i

export function normalizeIdToHex(value: unknown): string {
  if (typeof value !== 'string' || value === '') return ''
  // Already hex
  if (HEX_PATTERN.test(value)) return value.toLowerCase()
  // Assume base64 — decode to hex
  try {
    // Use atob (available in Node 16+, CF Workers, browsers) for cross-platform base64 decode
    const binary = atob(value)
    let hex = ''
    for (let i = 0; i < binary.length; i++) {
      hex += binary.charCodeAt(i).toString(16).padStart(2, '0')
    }
    return hex
  } catch {
    return ''
  }
}
