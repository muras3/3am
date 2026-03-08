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
}

export function isAnomalous(span: ExtractedSpan): boolean {
  if (span.httpStatusCode !== undefined && span.httpStatusCode >= 500) {
    return true
  }
  if (span.spanStatusCode === 2) {
    return true
  }
  return false
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
    if (resourceSpan === null || typeof resourceSpan !== 'object') continue
    const rs = resourceSpan as Record<string, unknown>

    const resource = rs['resource'] as Record<string, unknown> | undefined
    const resourceAttrs: OtlpAttribute[] = Array.isArray(resource?.['attributes'])
      ? (resource['attributes'] as OtlpAttribute[])
      : []

    const serviceName = getAttr(resourceAttrs, 'service.name') ?? ''
    const environment = getAttr(resourceAttrs, 'deployment.environment.name') ?? ''

    const scopeSpans = Array.isArray(rs['scopeSpans']) ? (rs['scopeSpans'] as unknown[]) : []

    for (const scopeSpan of scopeSpans) {
      if (scopeSpan === null || typeof scopeSpan !== 'object') continue
      const ss = scopeSpan as Record<string, unknown>
      const spans = Array.isArray(ss['spans']) ? (ss['spans'] as unknown[]) : []

      for (const rawSpan of spans) {
        if (rawSpan === null || typeof rawSpan !== 'object') continue
        const s = rawSpan as Record<string, unknown>

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
        })
      }
    }
  }

  return result
}
