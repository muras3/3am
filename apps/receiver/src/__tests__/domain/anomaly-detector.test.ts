import { describe, it, expect } from 'vitest'
import { isAnomalous, extractSpans, type ExtractedSpan } from '../../domain/anomaly-detector.js'

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
    const span = spans[0]
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
    expect(spans[0].peerService).toBe('stripe')
  })

  it('extracts exceptionCount from exception events (ADR 0023)', () => {
    const spans = extractSpans(validPayload)
    expect(spans[0].exceptionCount).toBe(1)
  })

  it('sets exceptionCount=0 when no exception events', () => {
    const payloadNoEvents = {
      ...validPayload,
      resourceSpans: [{
        ...validPayload.resourceSpans[0],
        scopeSpans: [{
          spans: [{
            ...validPayload.resourceSpans[0].scopeSpans[0].spans[0],
            events: [],
          }],
        }],
      }],
    }
    const spans = extractSpans(payloadNoEvents)
    expect(spans[0].exceptionCount).toBe(0)
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
})
