export type ExtractedSpan = {
  traceId: string
  spanId: string
  serviceName: string
  environment: string
  httpRoute?: string
  httpStatusCode?: number
  spanStatusCode: number // 0=unset, 1=ok, 2=error (OTLP span.status.code)
  durationMs: number
  startTimeMs: number
  exceptionCount: number  // number of exception events in this span
  peerService?: string    // peer.service attribute (ADR 0023 required dependency id)
}

// Spans slower than this threshold are considered anomalous (ADR 0023)
const SLOW_SPAN_THRESHOLD_MS = 5000

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

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object'
}

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

function nanoStringToMs(nanoStr: string): number {
  return Number(BigInt(nanoStr) / BigInt(1_000_000))
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

        const startTimeMs = nanoStringToMs(String(s['startTimeUnixNano'] ?? '0'))
        const endTimeMs = nanoStringToMs(String(s['endTimeUnixNano'] ?? '0'))
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
