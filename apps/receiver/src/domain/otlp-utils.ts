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
 * Known dummy service.name values that CF Workers Observability sets on its
 * own auto-instrumented traces.  When forwarded via OTLP destinations these
 * would mask the real worker name available in faas.name / cloudflare.script_name.
 */
const CF_DUMMY_SERVICE_NAMES = new Set([
  'cloudflare-workers-observability',
])

/**
 * Resolve the logical service name from OTLP resource attributes.
 * CF Workers OTLP may set service.name to a generic platform value — skip it
 * and fall back to faas.name / cloudflare.script_name in that case.
 */
export function resolveResourceServiceName(attrs: unknown): string {
  const serviceName = getStringAttr(attrs, 'service.name')
  if (serviceName && !CF_DUMMY_SERVICE_NAMES.has(serviceName)) {
    return serviceName
  }
  return (
    getStringAttr(attrs, 'faas.name') ||
    getStringAttr(attrs, 'cloudflare.script_name') ||
    serviceName ||  // still better than 'unknown' if no alternatives exist
    'unknown'
  )
}

/**
 * Resolve the deployment environment from OTLP resource attributes.
 * CF Workers OTLP may omit deployment.environment.name and send cloudflare.environment instead.
 */
export function resolveResourceEnvironment(attrs: unknown): string {
  return (
    getStringAttr(attrs, 'deployment.environment.name') ||
    getStringAttr(attrs, 'cloudflare.environment') ||
    'production'
  )
}

/**
 * Allowlist of OTLP attribute keys to persist in TelemetryStore.
 * Bounds payload size while retaining diagnostically significant fields.
 */
const ATTRIBUTE_ALLOWLIST = new Set([
  'http.route',
  'http.response.status_code',
  'http.request.method',
  // Stable OTel semconv (new SDKs)
  'server.address',
  'server.port',
  'db.query.text',
  'db.system.name',
  // Deprecated equivalents retained for backward compat with old SDK versions
  'peer.service',
  'url.full',
  'url.path',
  'db.system',
  'db.statement',
  'rpc.system',
  'rpc.method',
  'messaging.system',
  'error.type',
  'exception.type',
  'exception.message',
  'http.url',
  'http.status_code',
  'http.method',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'retry-after',
  'span.status',
])

/**
 * Convert an OTLP key-value attributes array to a flat Record<string, unknown>.
 * Only keys in ATTRIBUTE_ALLOWLIST are retained; all others are discarded.
 */
export function flattenOtlpAttributes(attrs: unknown): Record<string, unknown> {
  if (!isArray(attrs)) return {}
  const result: Record<string, unknown> = {}
  for (const attr of attrs) {
    if (!isRecord(attr)) continue
    const key = attr['key']
    if (typeof key !== 'string') continue
    if (!ATTRIBUTE_ALLOWLIST.has(key)) continue
    const val = attr['value']
    if (!isRecord(val)) continue
    if ('stringValue' in val) {
      result[key] = val['stringValue']
    } else if ('intValue' in val) {
      result[key] = val['intValue']
    } else if ('doubleValue' in val) {
      result[key] = val['doubleValue']
    } else if ('boolValue' in val) {
      result[key] = val['boolValue']
    }
  }
  return result
}

/**
 * Normalize a traceId/spanId value to lowercase hex.
 *
 * OTLP JSON transport uses lowercase hex strings. OTLP protobuf transport
 * decoded via JSON conversion returns base64-encoded strings for bytes fields.
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
