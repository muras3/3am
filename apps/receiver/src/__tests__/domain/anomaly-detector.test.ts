import { describe, it, expect } from 'vitest'
import {
  extractSpans,
  isAnomalous,
  isIncidentTrigger,
  selectIncidentTriggerSpans,
  type ExtractedSpan,
} from '../../domain/anomaly-detector.js'

describe('isAnomalous', () => {
  it('returns false for HTTP 200 span with spanStatusCode=1 (ok)', () => {
    const span: ExtractedSpan = {
      traceId: 'trace1',
      spanId: 'span1',
      serviceName: 'api',
      environment: 'production',
      httpStatusCode: 200,
      spanStatusCode: 1,
      durationMs: 100,
      startTimeMs: 1700000000000,
      exceptionCount: 0,
    }
    expect(isAnomalous(span)).toBe(false)
  })

  it('returns true for HTTP 500 span', () => {
    const span: ExtractedSpan = {
      traceId: 'trace1',
      spanId: 'span1',
      serviceName: 'api',
      environment: 'production',
      httpStatusCode: 500,
      spanStatusCode: 2,
      durationMs: 100,
      startTimeMs: 1700000000000,
      exceptionCount: 0,
    }
    expect(isAnomalous(span)).toBe(true)
  })

  it('returns true for HTTP 503 span', () => {
    const span: ExtractedSpan = {
      traceId: 'trace1',
      spanId: 'span1',
      serviceName: 'api',
      environment: 'production',
      httpStatusCode: 503,
      spanStatusCode: 2,
      durationMs: 100,
      startTimeMs: 1700000000000,
      exceptionCount: 0,
    }
    expect(isAnomalous(span)).toBe(true)
  })

  it('returns true for span with spanStatusCode=2 and no httpStatusCode', () => {
    const span: ExtractedSpan = {
      traceId: 'trace1',
      spanId: 'span1',
      serviceName: 'api',
      environment: 'production',
      spanStatusCode: 2,
      durationMs: 100,
      startTimeMs: 1700000000000,
      exceptionCount: 0,
    }
    expect(isAnomalous(span)).toBe(true)
  })

  it('returns false for HTTP 404 span (4xx client errors are not anomalies)', () => {
    const span: ExtractedSpan = {
      traceId: 'trace1',
      spanId: 'span1',
      serviceName: 'api',
      environment: 'production',
      httpStatusCode: 404,
      spanStatusCode: 1,
      durationMs: 100,
      startTimeMs: 1700000000000,
      exceptionCount: 0,
    }
    expect(isAnomalous(span)).toBe(false)
  })

  it('returns true for HTTP 429 span (rate limit — ADR 0023)', () => {
    const span: ExtractedSpan = {
      traceId: 'trace1',
      spanId: 'span1',
      serviceName: 'api',
      environment: 'production',
      httpStatusCode: 429,
      spanStatusCode: 1,
      durationMs: 100,
      startTimeMs: 1700000000000,
      exceptionCount: 0,
    }
    expect(isAnomalous(span)).toBe(true)
  })

  it('returns true for slow span exceeding 5000ms threshold (ADR 0023)', () => {
    const span: ExtractedSpan = {
      traceId: 'trace1',
      spanId: 'span1',
      serviceName: 'api',
      environment: 'production',
      spanStatusCode: 1,
      durationMs: 5001,
      startTimeMs: 1700000000000,
      exceptionCount: 0,
    }
    expect(isAnomalous(span)).toBe(true)
  })

  it('returns false for span at exactly 5000ms (boundary — not exceeding threshold)', () => {
    const span: ExtractedSpan = {
      traceId: 'trace1',
      spanId: 'span1',
      serviceName: 'api',
      environment: 'production',
      spanStatusCode: 1,
      durationMs: 5000,
      startTimeMs: 1700000000000,
      exceptionCount: 0,
    }
    expect(isAnomalous(span)).toBe(false)
  })

  it('returns true for span with exception events (ADR 0023)', () => {
    const span: ExtractedSpan = {
      traceId: 'trace1',
      spanId: 'span1',
      serviceName: 'api',
      environment: 'production',
      spanStatusCode: 1,
      durationMs: 100,
      startTimeMs: 1700000000000,
      exceptionCount: 1,
    }
    expect(isAnomalous(span)).toBe(true)
  })
})

describe('extractSpans', () => {
  const validPayload = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'api-service' } },
            { key: 'deployment.environment.name', value: { stringValue: 'production' } },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 'abc123',
                spanId: 'span001',
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000001000000000',
                status: { code: 2 },
                attributes: [
                  { key: 'http.route', value: { stringValue: '/checkout' } },
                  { key: 'http.response.status_code', value: { intValue: '500' } },
                  { key: 'peer.service', value: { stringValue: 'stripe' } },
                ],
                events: [
                  { name: 'exception', attributes: [] },
                ],
              },
            ],
          },
        ],
      },
    ],
  }

  it('extracts correct span fields from a valid OTLP payload', () => {
    const spans = extractSpans(validPayload)
    expect(spans).toHaveLength(1)
    const span = spans[0]!
    expect(span.serviceName).toBe('api-service')
    expect(span.environment).toBe('production')
    expect(span.traceId).toBe('abc123')
    expect(span.spanId).toBe('span001')
    expect(span.httpRoute).toBe('/checkout')
    expect(span.httpStatusCode).toBe(500)
    expect(span.spanStatusCode).toBe(2)
    expect(span.durationMs).toBe(1000)
    expect(span.startTimeMs).toBeGreaterThan(0)
  })

  it('extracts peerService from peer.service attribute (ADR 0023)', () => {
    const spans = extractSpans(validPayload)
    expect(spans[0]!.peerService).toBe('stripe')
  })

  it('extracts exceptionCount from exception events (ADR 0023)', () => {
    const spans = extractSpans(validPayload)
    expect(spans[0]!.exceptionCount).toBe(1)
  })

  it('sets exceptionCount=0 when no exception events', () => {
    const payloadNoEvents = {
      ...validPayload,
      resourceSpans: [{
        ...validPayload.resourceSpans[0]!,
        scopeSpans: [{
          spans: [{
            ...validPayload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!,
            events: [],
          }],
        }],
      }],
    }
    const spans = extractSpans(payloadNoEvents)
    expect(spans[0]!.exceptionCount).toBe(0)
  })

  it('returns [] for null payload', () => {
    expect(extractSpans(null)).toEqual([])
  })

  it('returns [] for empty object payload', () => {
    expect(extractSpans({})).toEqual([])
  })

  it('returns [] for payload with empty resourceSpans array', () => {
    expect(extractSpans({ resourceSpans: [] })).toEqual([])
  })

  it('extracts spanKind from span.kind field', () => {
    const payload = {
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'mock-stripe' } }] },
        scopeSpans: [{
          spans: [{
            traceId: 'abc123', spanId: 'span001', kind: 2,
            startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000001000000000',
            status: { code: 0 }, attributes: [], events: [],
          }],
        }],
      }],
    }
    const spans = extractSpans(payload)
    expect(spans[0]!.spanKind).toBe(2)
  })

  it('sets spanKind to undefined when span.kind is absent', () => {
    const payload = {
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'api' } }] },
        scopeSpans: [{
          spans: [{
            traceId: 'abc123', spanId: 'span001',
            startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000001000000000',
            status: { code: 0 }, attributes: [], events: [],
          }],
        }],
      }],
    }
    const spans = extractSpans(payload)
    expect(spans[0]!.spanKind).toBeUndefined()
  })

  it('uses server.address as peerService fallback when peer.service is absent (new SDK)', () => {
    const payload = {
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'api-service' } }] },
        scopeSpans: [{
          spans: [{
            traceId: 'abc123', spanId: 'span001',
            startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000001000000000',
            status: { code: 0 },
            attributes: [
              { key: 'server.address', value: { stringValue: 'api.stripe.com' } },
            ],
            events: [],
          }],
        }],
      }],
    }
    const spans = extractSpans(payload)
    expect(spans[0]!.peerService).toBe('api.stripe.com')
  })

  it('prefers peer.service over server.address when both are present (backward compat)', () => {
    const payload = {
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'api-service' } }] },
        scopeSpans: [{
          spans: [{
            traceId: 'abc123', spanId: 'span001',
            startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000001000000000',
            status: { code: 0 },
            attributes: [
              { key: 'peer.service', value: { stringValue: 'stripe' } },
              { key: 'server.address', value: { stringValue: 'api.stripe.com' } },
            ],
            events: [],
          }],
        }],
      }],
    }
    const spans = extractSpans(payload)
    expect(spans[0]!.peerService).toBe('stripe')
  })

  it('sets peerService to undefined when neither peer.service nor server.address is present', () => {
    const payload = {
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'api-service' } }] },
        scopeSpans: [{
          spans: [{
            traceId: 'abc123', spanId: 'span001',
            startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000001000000000',
            status: { code: 0 },
            attributes: [],
            events: [],
          }],
        }],
      }],
    }
    const spans = extractSpans(payload)
    expect(spans[0]!.peerService).toBeUndefined()
  })
})

// ── isIncidentTrigger ─────────────────────────────────────────────────────────

describe('isIncidentTrigger', () => {
  const base: ExtractedSpan = {
    traceId: 'trace1', spanId: 'span1', serviceName: 'svc',
    environment: 'production', spanStatusCode: 0,
    durationMs: 100, startTimeMs: 1700000000000, exceptionCount: 0,
  }

  // ── SERVER 429 is NOT a trigger (deliberate rate-limiting) ────────────────

  it('returns false for SERVER span (kind=2) with HTTP 429', () => {
    expect(isIncidentTrigger({ ...base, httpStatusCode: 429, spanKind: 2 })).toBe(false)
  })

  it('returns false for SERVER span (kind=2) with HTTP 429 even when spanStatus=ERROR', () => {
    // spanStatus=ERROR does not override the SERVER 429 rule
    expect(isIncidentTrigger({ ...base, httpStatusCode: 429, spanStatusCode: 2, spanKind: 2 })).toBe(false)
  })

  // ── INTERNAL 429 is also NOT a trigger (OTel SDK quirk: SERVER exported as INTERNAL) ──────

  it('returns false for INTERNAL span (kind=1) with HTTP 429', () => {
    // Some OTel SDK versions export SERVER spans as INTERNAL due to API vs OTLP enum offset.
    // Mock-stripe is a known case: tracer.startActiveSpan("stripe.charge", { kind: SpanKind.SERVER })
    // results in kind=1 in the exported protobuf. Apply the same conservative rule as SERVER 429.
    expect(isIncidentTrigger({ ...base, httpStatusCode: 429, spanKind: 1 })).toBe(false)
  })

  it('returns false for INTERNAL span (kind=1) with HTTP 429 even when spanStatus=ERROR', () => {
    expect(isIncidentTrigger({ ...base, httpStatusCode: 429, spanStatusCode: 2, spanKind: 1 })).toBe(false)
  })

  // ── Non-SERVER/INTERNAL 429 IS a trigger ──────────────────────────────────

  it('returns true for CLIENT span (kind=3) with HTTP 429 — being rate-limited by upstream', () => {
    expect(isIncidentTrigger({ ...base, httpStatusCode: 429, spanKind: 3 })).toBe(true)
  })

  it('returns true for HTTP 429 when spanKind is absent — backward compatible safe default', () => {
    expect(isIncidentTrigger({ ...base, httpStatusCode: 429 })).toBe(true)
  })

  // ── SERVER 5xx is still a trigger (local failure) ─────────────────────────

  it('returns true for SERVER span (kind=2) with HTTP 500', () => {
    expect(isIncidentTrigger({ ...base, httpStatusCode: 500, spanStatusCode: 2, spanKind: 2 })).toBe(true)
  })

  // ── Non-429 anomaly conditions pass through unchanged ─────────────────────

  it('returns true for SERVER span with spanStatus=ERROR and no httpStatusCode', () => {
    expect(isIncidentTrigger({ ...base, spanStatusCode: 2, spanKind: 2 })).toBe(true)
  })

  it('returns true for slow span regardless of kind', () => {
    expect(isIncidentTrigger({ ...base, durationMs: 5001, spanKind: 2 })).toBe(true)
  })

  it('returns true for span with exceptionCount > 0 regardless of kind', () => {
    expect(isIncidentTrigger({ ...base, exceptionCount: 1, spanKind: 2 })).toBe(true)
  })

  it('returns false for normal healthy span', () => {
    expect(isIncidentTrigger({ ...base, httpStatusCode: 200 })).toBe(false)
  })
})

describe('selectIncidentTriggerSpans', () => {
  const base: ExtractedSpan = {
    traceId: 'trace1',
    spanId: 'span1',
    serviceName: 'validation-web',
    environment: 'production',
    httpStatusCode: 401,
    spanStatusCode: 2,
    durationMs: 100,
    startTimeMs: 1700000000000,
    exceptionCount: 0,
    spanKind: 1,
    peerService: 'sendgrid',
  }

  it('treats repeated dependency 401 spans as incident triggers', () => {
    const spans = [
      { ...base, traceId: 'trace-1', spanId: 'span-1', startTimeMs: 1700000000000 },
      { ...base, traceId: 'trace-2', spanId: 'span-2', startTimeMs: 1700000001000 },
    ]

    expect(selectIncidentTriggerSpans(spans)).toEqual(spans)
  })

  it('does not treat a single dependency auth failure as an incident trigger', () => {
    expect(selectIncidentTriggerSpans([base])).toEqual([])
  })

  it('keeps SERVER 429 as a non-trigger', () => {
    const span = {
      ...base,
      traceId: 'trace-429',
      spanId: 'span-429',
      serviceName: 'mock-sendgrid',
      peerService: undefined,
      httpStatusCode: 429,
      spanKind: 2,
    }

    expect(selectIncidentTriggerSpans([span])).toEqual([])
  })
})
