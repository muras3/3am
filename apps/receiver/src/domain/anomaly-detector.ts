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
}

// Spans slower than this threshold are considered anomalous (ADR 0023)
const SLOW_SPAN_THRESHOLD_MS = 5000

// OTel span kind value for server-side spans (https://opentelemetry.io/docs/specs/otel/trace/api/#spankind)
const SPAN_KIND_SERVER = 2

// HTTP status codes with special anomaly trigger semantics
const HTTP_RATE_LIMITED = 429

export function isAnomalous(span: ExtractedSpan): boolean {
  if (span.httpStatusCode !== undefined && span.httpStatusCode >= 500) {
    return true
  }
  if (span.httpStatusCode === HTTP_RATE_LIMITED) {
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
 * | httpStatus = 429   | **✗**  |   ✓    |    ✓     |    ✓ (safe default)|
 * | spanStatus = ERROR |   ✓    |   ✓    |    ✓     |         ✓          |
 * | duration > 5000ms  |   ✓    |   ✓    |    ✓     |         ✓          |
 * | exceptionCount > 0 |   ✓    |   ✓    |    ✓     |         ✓          |
 *
 * SERVER + 429: "I am deliberately rate-limiting my callers" — not a service failure.
 *   Even if spanStatus=ERROR is also set, the 429 rule takes precedence.
 * UNSPECIFIED/absent spanKind: treated as trigger-eligible (backward-compatible safe default).
 *
 * Note: SERVER 429 spans are still anomalous signal evidence (isAnomalous returns true)
 * and may be attached to an existing incident's rawState; they just cannot start a new one.
 */
export function isIncidentTrigger(span: ExtractedSpan): boolean {
  // SERVER 429 is deliberate rate-limiting — not a failure that should open an incident.
  // This takes precedence over spanStatus=ERROR which the instrumentation may also set.
  if (span.httpStatusCode === 429 && span.spanKind === SPAN_KIND_SERVER) {
    return false
  }
  return isAnomalous(span)
}

import { isRecord, nanoToMs } from './otlp-utils.js'

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
        })
      }
    }
  }

  return result
}
