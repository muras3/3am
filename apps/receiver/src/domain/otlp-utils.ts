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
