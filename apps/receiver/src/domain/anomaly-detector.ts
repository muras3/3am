export type ExtractedSpan = {
  traceId: string
  spanId: string
  serviceName: string
  environment: string
  httpRoute?: string
  httpStatusCode?: number
  spanStatusCode: number // 0=unset, 1=ok, 2=error (OTLP span.status.code)
  spanKind?: number      // OTel span kind: 1=INTERNAL, 2=SERVER, 3=CLIENT, 4=PRODUCER, 5=CONSUMER
  durationMs: number
  startTimeMs: number
  exceptionCount: number  // number of exception events in this span
  peerService?: string    // peer.service attribute (ADR 0023 required dependency id)
  parentSpanId?: string   // parent span for APM waterfall tree
  spanName?: string       // OTLP span.name (operation name)
  httpMethod?: string     // http.request.method attribute
  attributes?: Record<string, unknown>  // allowlisted OTLP span attributes
}

// Spans slower than this threshold are considered anomalous (ADR 0023)
export const SLOW_SPAN_THRESHOLD_MS = 5000
export const DEPENDENCY_AUTH_FAILURE_CODES = new Set([401, 403])
export const DEPENDENCY_AUTH_FAILURE_MIN_REPETITIONS = 2
export const DEPENDENCY_AUTH_FAILURE_WINDOW_MS = 60 * 1000

// OTel span kind values (https://opentelemetry.io/docs/specs/otel/trace/api/#spankind)
// NOTE: Some OTel SDK versions export SERVER spans as INTERNAL (kind=1) due to
// a 0-based API enum vs 1-based OTLP protobuf enum mapping discrepancy.
const SPAN_KIND_SERVER = 2
const SPAN_KIND_INTERNAL = 1

function normalizeDependency(raw: string | undefined): string | undefined {
  if (!raw || raw.trim() === '') return undefined
  return raw.trim().toLowerCase()
}

export function isAnomalous(span: ExtractedSpan): boolean {
  if (span.httpStatusCode !== undefined && span.httpStatusCode >= 500) {
    return true
  }
  if (span.httpStatusCode === 429) {
    return true
  }
  if (span.spanStatusCode === 2) {
    return true
  }
  if (span.durationMs > SLOW_SPAN_THRESHOLD_MS) {
    return true
  }
  if (span.exceptionCount > 0) {
    return true
  }
  return false
}

/**
 * Determines whether an anomalous span is eligible to open (or attach to) an incident.
 *
 * Separates "telemetry anomaly detection" (isAnomalous) from "incident trigger eligibility":
 * a span can be anomalous as evidence without being the right anchor for a new incident.
 *
 * Span-kind-aware rule table:
 *
 * | Condition          | SERVER | CLIENT | INTERNAL | UNSPECIFIED/absent |
 * |--------------------|--------|--------|----------|--------------------|
 * | httpStatus ≥ 500   |   ✓    |   ✓    |    ✓     |         ✓          |
 * | httpStatus = 429   | **✗**  |   ✓    | **✗**    |    ✓ (safe default)|
 * | spanStatus = ERROR |   ✓    |   ✓    |    ✓     |         ✓          |
 * | duration > 5000ms  |   ✓    |   ✓    |    ✓     |         ✓          |
 * | exceptionCount > 0 |   ✓    |   ✓    |    ✓     |         ✓          |
 *
 * SERVER + 429: "I am deliberately rate-limiting my callers" — not a service failure.
 *   Even if spanStatus=ERROR is also set, the 429 rule takes precedence.
 * INTERNAL + 429: Treated like SERVER. Some OTel SDK versions export SERVER spans as
 *   INTERNAL (kind=1) due to API vs OTLP protobuf enum offset (API.SERVER=1 → OTLP.INTERNAL=1).
 *   Applying the same conservative rule prevents spurious incidents from mislabeled rate-limit spans.
 * UNSPECIFIED/absent spanKind: treated as trigger-eligible (backward-compatible safe default).
 *
 * Note: SERVER 429 spans are still anomalous signal evidence (isAnomalous returns true)
 * and may be attached to an existing incident's membership; they just cannot start a new one.
 */
export function isIncidentTrigger(span: ExtractedSpan): boolean {
  if (span.spanKind === SPAN_KIND_SERVER || span.spanKind === SPAN_KIND_INTERNAL) {
    if (span.httpStatusCode !== undefined) {
      // HTTP server/internal span: httpStatusCode is the authoritative signal.
      // 4xx responses (incl. 429 rate-limiting) are deliberate decisions, not failures.
      return span.httpStatusCode >= 500
    }
    // Non-HTTP server span (gRPC, messaging, etc.): use span status and other signals.
    return (
      span.spanStatusCode === 2 ||
      span.durationMs > SLOW_SPAN_THRESHOLD_MS ||
      span.exceptionCount > 0
    )
  }
  return isAnomalous(span)
}

export function isDependencyAuthFailure(span: ExtractedSpan): boolean {
  const dependency = normalizeDependency(span.peerService)
  return (
    dependency !== undefined &&
    span.httpStatusCode !== undefined &&
    DEPENDENCY_AUTH_FAILURE_CODES.has(span.httpStatusCode) &&
    span.spanStatusCode === 2
  )
}

function hasShortWindowRepetition(spans: ExtractedSpan[]): boolean {
  if (spans.length < DEPENDENCY_AUTH_FAILURE_MIN_REPETITIONS) return false

  const sorted = spans
    .slice()
    .sort((a, b) => a.startTimeMs - b.startTimeMs)

  for (let left = 0; left < sorted.length; left++) {
    let right = left
    const leftSpan = sorted[left]
    if (leftSpan === undefined) continue
    while (right < sorted.length) {
      const rightSpan = sorted[right]
      if (rightSpan === undefined) break
      if (rightSpan.startTimeMs - leftSpan.startTimeMs > DEPENDENCY_AUTH_FAILURE_WINDOW_MS) break
      right += 1
    }
    if (right - left >= DEPENDENCY_AUTH_FAILURE_MIN_REPETITIONS) {
      return true
    }
  }

  return false
}

export function selectIncidentTriggerSpans(spans: ExtractedSpan[]): ExtractedSpan[] {
  const triggerKeys = new Set<string>()

  for (const span of spans) {
    if (isIncidentTrigger(span)) {
      triggerKeys.add(`${span.traceId}:${span.spanId}`)
    }
  }

  const dependencyAuthGroups = new Map<string, ExtractedSpan[]>()
  for (const span of spans) {
    if (!isDependencyAuthFailure(span)) continue
    const dependency = normalizeDependency(span.peerService)
    if (dependency === undefined || span.httpStatusCode === undefined) continue
    const key = [
      span.environment,
      span.serviceName,
      dependency,
      String(span.httpStatusCode),
    ].join('|')
    const existing = dependencyAuthGroups.get(key)
    if (existing) {
      existing.push(span)
    } else {
      dependencyAuthGroups.set(key, [span])
    }
  }

  for (const group of dependencyAuthGroups.values()) {
    if (!hasShortWindowRepetition(group)) continue
    for (const span of group) {
      triggerKeys.add(`${span.traceId}:${span.spanId}`)
    }
  }

  return spans.filter((span) => triggerKeys.has(`${span.traceId}:${span.spanId}`))
}

import { isRecord, nanoToMs, flattenOtlpAttributes } from './otlp-utils.js'

type OtlpAttributeValue =
  | { stringValue: string }
  | { intValue: string | number }
  | { doubleValue: number }

type OtlpAttribute = { key: string; value: OtlpAttributeValue }

function getAttr(attrs: OtlpAttribute[], key: string): string | undefined {
  const attr = attrs.find((a) => a.key === key)
  if (!attr) return undefined
  const val = attr.value
  if ('stringValue' in val) return val.stringValue
  if ('intValue' in val) return String(val.intValue)
  if ('doubleValue' in val) return String(val.doubleValue)
  return undefined
}


export function extractSpans(payload: unknown): ExtractedSpan[] {
  if (payload === null || typeof payload !== 'object') {
    return []
  }

  const p = payload as Record<string, unknown>
  if (!Array.isArray(p['resourceSpans'])) {
    return []
  }

  const result: ExtractedSpan[] = []

  for (const resourceSpan of p['resourceSpans'] as unknown[]) {
    if (!isRecord(resourceSpan)) continue
    const rs = resourceSpan

    const resource = rs['resource'] as Record<string, unknown> | undefined
    const resourceAttrs: OtlpAttribute[] = Array.isArray(resource?.['attributes'])
      ? (resource['attributes'] as OtlpAttribute[])
      : []

    const serviceName = getAttr(resourceAttrs, 'service.name') ?? ''
    const environment = getAttr(resourceAttrs, 'deployment.environment.name') ?? ''

    const scopeSpans = Array.isArray(rs['scopeSpans']) ? (rs['scopeSpans'] as unknown[]) : []

    for (const scopeSpan of scopeSpans) {
      if (!isRecord(scopeSpan)) continue
      const ss = scopeSpan
      const spans = Array.isArray(ss['spans']) ? (ss['spans'] as unknown[]) : []

      for (const rawSpan of spans) {
        if (!isRecord(rawSpan)) continue
        const s = rawSpan

        const traceId = typeof s['traceId'] === 'string' ? s['traceId'] : ''
        const spanId = typeof s['spanId'] === 'string' ? s['spanId'] : ''
        const spanKind = typeof s['kind'] === 'number' ? s['kind'] : undefined

        const startTimeMs = nanoToMs(s['startTimeUnixNano']) ?? 0
        const endTimeMs = nanoToMs(s['endTimeUnixNano']) ?? 0
        const durationMs = endTimeMs - startTimeMs

        const status = s['status'] as Record<string, unknown> | undefined
        const spanStatusCode = typeof status?.['code'] === 'number' ? status['code'] : 0

        const attrs: OtlpAttribute[] = Array.isArray(s['attributes'])
          ? (s['attributes'] as OtlpAttribute[])
          : []

        const httpRoute = getAttr(attrs, 'http.route')
        const httpStatusCodeStr = getAttr(attrs, 'http.response.status_code')
        const httpStatusCode =
          httpStatusCodeStr !== undefined ? Number(httpStatusCodeStr) : undefined

        const peerService = getAttr(attrs, 'peer.service')

        const events = Array.isArray(s['events']) ? (s['events'] as unknown[]) : []
        const exceptionCount = events.filter((e) => isRecord(e) && e['name'] === 'exception').length

        const parentSpanId = (typeof s['parentSpanId'] === 'string' && s['parentSpanId'] !== '') ? s['parentSpanId'] : undefined
        const spanName = typeof s['name'] === 'string' ? s['name'] : undefined
        const httpMethod = getAttr(attrs, 'http.request.method')

        result.push({
          traceId,
          spanId,
          serviceName,
          environment,
          httpRoute,
          httpStatusCode,
          spanStatusCode,
          spanKind,
          durationMs,
          startTimeMs,
          exceptionCount,
          peerService,
          parentSpanId,
          spanName,
          httpMethod,
          attributes: flattenOtlpAttributes(s['attributes']),
        })
      }
    }
  }

  return result
}
