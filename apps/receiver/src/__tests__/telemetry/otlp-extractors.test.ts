import { describe, it, expect } from 'vitest'
import { extractTelemetryMetrics, extractTelemetryLogs } from '../../telemetry/otlp-extractors.js'

// ── Fixtures ───────────────────────────────────────────────────────────────

const BASE_TIME_NS = '1741392000000000000' // 2025-03-07T16:00:00Z as nano string
const BASE_TIME_MS = 1741392000000
const SECOND_TIME_NS = '1741392060000000000' // +60s
const SECOND_TIME_MS = 1741392060000

function makeResourceMetrics(overrides: {
  serviceName?: string
  environment?: string
  metricName?: string
  histogram?: { dataPoints: object[] }
  gauge?: { dataPoints: object[] }
  sum?: { dataPoints: object[] }
}) {
  const {
    serviceName = 'svc-a',
    environment = 'production',
    metricName = 'http.server.request.duration',
    histogram,
    gauge,
    sum,
  } = overrides

  const metricObj: Record<string, unknown> = { name: metricName }
  if (histogram) metricObj['histogram'] = histogram
  if (gauge) metricObj['gauge'] = gauge
  if (sum) metricObj['sum'] = sum

  // Default: histogram with single datapoint if nothing specified
  if (!histogram && !gauge && !sum) {
    metricObj['histogram'] = {
      dataPoints: [{
        startTimeUnixNano: BASE_TIME_NS,
        timeUnixNano: BASE_TIME_NS,
        count: '42',
        sum: 1234.5,
        min: 1.0,
        max: 99.0,
        bucketCounts: ['10', '20', '12'],
        explicitBounds: [5, 50],
      }],
    }
  }

  return {
    resourceMetrics: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: serviceName } },
          { key: 'deployment.environment.name', value: { stringValue: environment } },
        ],
      },
      scopeMetrics: [{ metrics: [metricObj] }],
    }],
  }
}

function makeResourceLogs(overrides: {
  serviceName?: string
  environment?: string
  severityNumber?: number
  bodyString?: string
  bodyOther?: unknown
  timeUnixNano?: string
  traceId?: string
  spanId?: string
  attributes?: object[]
}) {
  const {
    serviceName = 'svc-a',
    environment = 'production',
    severityNumber = 17, // ERROR
    bodyString,
    bodyOther,
    timeUnixNano = BASE_TIME_NS,
    traceId,
    spanId,
    attributes = [{ key: 'orderId', value: { stringValue: 'ord_001' } }],
  } = overrides

  const body = bodyString !== undefined
    ? { stringValue: bodyString }
    : bodyOther !== undefined ? bodyOther : { stringValue: 'checkout failed' }

  const logRecord: Record<string, unknown> = {
    timeUnixNano,
    severityNumber,
    severityText: severityNumber >= 21 ? 'FATAL' : severityNumber >= 17 ? 'ERROR' : 'WARN',
    body,
    attributes,
  }
  if (traceId !== undefined) logRecord['traceId'] = traceId
  if (spanId !== undefined) logRecord['spanId'] = spanId

  return {
    resourceLogs: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: serviceName } },
          { key: 'deployment.environment.name', value: { stringValue: environment } },
        ],
      },
      scopeLogs: [{ logRecords: [logRecord] }],
    }],
  }
}

// ── extractTelemetryMetrics ────────────────────────────────────────────────

describe('extractTelemetryMetrics', () => {
  it('extracts ALL datapoints from a histogram (not just first)', () => {
    const body = makeResourceMetrics({
      histogram: {
        dataPoints: [
          { timeUnixNano: BASE_TIME_NS, count: '10', sum: 100 },
          { timeUnixNano: SECOND_TIME_NS, count: '20', sum: 300 },
        ],
      },
    })
    const result = extractTelemetryMetrics(body)
    expect(result).toHaveLength(2)
    expect(result[0]!.startTimeMs).toBe(BASE_TIME_MS)
    expect(result[1]!.startTimeMs).toBe(SECOND_TIME_MS)
  })

  it('extracts histogram datapoint and compresses (drops bucket arrays)', () => {
    const body = makeResourceMetrics({})
    const result = extractTelemetryMetrics(body)
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe('http.server.request.duration')
    expect(result[0]!.service).toBe('svc-a')
    expect(result[0]!.environment).toBe('production')
    expect(result[0]!.startTimeMs).toBe(BASE_TIME_MS)

    const summary = result[0]!.summary as Record<string, unknown>
    expect(summary.count).toBe('42')
    expect(summary.sum).toBe(1234.5)
    expect(summary.min).toBe(1.0)
    expect(summary.max).toBe(99.0)
    // Bucket arrays must be stripped
    expect(summary.bucketCounts).toBeUndefined()
    expect(summary.explicitBounds).toBeUndefined()
  })

  it('extracts gauge datapoints', () => {
    const body = makeResourceMetrics({
      metricName: 'process.cpu.usage',
      gauge: {
        dataPoints: [
          { timeUnixNano: BASE_TIME_NS, asDouble: 0.42 },
          { timeUnixNano: SECOND_TIME_NS, asDouble: 0.85 },
        ],
      },
    })
    const result = extractTelemetryMetrics(body)
    expect(result).toHaveLength(2)
    expect((result[0]!.summary as Record<string, unknown>).asDouble).toBe(0.42)
    expect((result[1]!.summary as Record<string, unknown>).asDouble).toBe(0.85)
  })

  it('extracts sum datapoints', () => {
    const body = makeResourceMetrics({
      metricName: 'http.server.request.count',
      sum: {
        dataPoints: [
          { timeUnixNano: BASE_TIME_NS, asInt: '100' },
        ],
      },
    })
    const result = extractTelemetryMetrics(body)
    expect(result).toHaveLength(1)
    expect((result[0]!.summary as Record<string, unknown>).asInt).toBe('100')
  })

  it('extracts service.name from resource attributes', () => {
    const body = makeResourceMetrics({ serviceName: 'payment-svc' })
    const result = extractTelemetryMetrics(body)
    expect(result[0]!.service).toBe('payment-svc')
  })

  it('uses timeUnixNano for startTimeMs (observation time priority)', () => {
    const body = makeResourceMetrics({
      histogram: {
        dataPoints: [{
          timeUnixNano: BASE_TIME_NS,
          startTimeUnixNano: '1741391000000000000', // earlier
          count: '5',
          sum: 100,
        }],
      },
    })
    const result = extractTelemetryMetrics(body)
    expect(result[0]!.startTimeMs).toBe(BASE_TIME_MS) // uses timeUnixNano
  })

  it('falls back to startTimeUnixNano when timeUnixNano is missing', () => {
    const body = makeResourceMetrics({
      histogram: {
        dataPoints: [{
          startTimeUnixNano: BASE_TIME_NS,
          count: '5',
          sum: 100,
        }],
      },
    })
    const result = extractTelemetryMetrics(body)
    expect(result).toHaveLength(1)
    expect(result[0]!.startTimeMs).toBe(BASE_TIME_MS)
  })

  it('drops datapoints with no timestamps', () => {
    const body = makeResourceMetrics({
      histogram: {
        dataPoints: [{ count: '5', sum: 100 }],
      },
    })
    expect(extractTelemetryMetrics(body)).toHaveLength(0)
  })

  it('sets ingestedAt to approximately current time', () => {
    const before = Date.now()
    const body = makeResourceMetrics({})
    const result = extractTelemetryMetrics(body)
    const after = Date.now()
    expect(result[0]!.ingestedAt).toBeGreaterThanOrEqual(before)
    expect(result[0]!.ingestedAt).toBeLessThanOrEqual(after)
  })

  it('skips resources with no service.name', () => {
    const body = {
      resourceMetrics: [{
        resource: { attributes: [] },
        scopeMetrics: [{ metrics: [{ name: 'foo', gauge: { dataPoints: [{ timeUnixNano: BASE_TIME_NS, asDouble: 1 }] } }] }],
      }],
    }
    expect(extractTelemetryMetrics(body)).toHaveLength(0)
  })

  it('returns empty array for non-object input', () => {
    expect(extractTelemetryMetrics(null)).toHaveLength(0)
    expect(extractTelemetryMetrics('bad')).toHaveLength(0)
  })

  it('returns empty array for empty resourceMetrics', () => {
    expect(extractTelemetryMetrics({ resourceMetrics: [] })).toHaveLength(0)
  })

  it('handles multiple metrics in a single scope', () => {
    const body = {
      resourceMetrics: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'svc-a' } },
            { key: 'deployment.environment.name', value: { stringValue: 'production' } },
          ],
        },
        scopeMetrics: [{
          metrics: [
            { name: 'metric_a', gauge: { dataPoints: [{ timeUnixNano: BASE_TIME_NS, asDouble: 1.0 }] } },
            { name: 'metric_b', gauge: { dataPoints: [{ timeUnixNano: BASE_TIME_NS, asDouble: 2.0 }] } },
          ],
        }],
      }],
    }
    const result = extractTelemetryMetrics(body)
    expect(result).toHaveLength(2)
    expect(result[0]!.name).toBe('metric_a')
    expect(result[1]!.name).toBe('metric_b')
  })
})

// ── extractTelemetryLogs ──────────────────────────────────────────────────

describe('extractTelemetryLogs', () => {
  it('extracts an ERROR log with all fields', async () => {
    const body = makeResourceLogs({
      severityNumber: 17,
      bodyString: 'checkout failed',
      traceId: 'abcdef0123456789abcdef0123456789',
      spanId: 'abcdef0123456789',
    })
    const result = await extractTelemetryLogs(body)
    expect(result).toHaveLength(1)
    expect(result[0]!.severity).toBe('ERROR')
    expect(result[0]!.severityNumber).toBe(17)
    expect(result[0]!.body).toBe('checkout failed')
    expect(result[0]!.service).toBe('svc-a')
    expect(result[0]!.environment).toBe('production')
    expect(result[0]!.traceId).toBe('abcdef0123456789abcdef0123456789')
    expect(result[0]!.spanId).toBe('abcdef0123456789')
  })

  it('preserves severityNumber as a number', async () => {
    const body = makeResourceLogs({ severityNumber: 21 })
    const result = await extractTelemetryLogs(body)
    expect(result[0]!.severityNumber).toBe(21)
    expect(result[0]!.severity).toBe('FATAL')
  })

  it('extracts WARN severity (severityNumber 13)', async () => {
    const body = makeResourceLogs({ severityNumber: 13 })
    const result = await extractTelemetryLogs(body)
    expect(result).toHaveLength(1)
    expect(result[0]!.severity).toBe('WARN')
    expect(result[0]!.severityNumber).toBe(13)
  })

  it('filters out severity below WARN (severityNumber < 13)', async () => {
    const body = makeResourceLogs({ severityNumber: 12 })
    expect(await extractTelemetryLogs(body)).toHaveLength(0)
  })

  it('filters out DEBUG logs (severityNumber 5)', async () => {
    const body = makeResourceLogs({ severityNumber: 5 })
    expect(await extractTelemetryLogs(body)).toHaveLength(0)
  })

  it('extracts traceId and spanId from hex strings', async () => {
    const body = makeResourceLogs({
      traceId: 'abcdef0123456789abcdef0123456789',
      spanId: 'abcdef0123456789',
    })
    const result = await extractTelemetryLogs(body)
    expect(result[0]!.traceId).toBe('abcdef0123456789abcdef0123456789')
    expect(result[0]!.spanId).toBe('abcdef0123456789')
  })

  it('normalizes base64-encoded traceId to hex (protobuf transport)', async () => {
    // base64 of 16 bytes (32 hex chars traceId)
    // "q83vASNFZ4mrze8BI0VniQ==" is base64 for 0xabcdef0123456789abcdef0123456789
    const traceIdBase64 = 'q83vASNFZ4mrze8BI0VniQ=='
    const body = makeResourceLogs({ traceId: traceIdBase64 })
    const result = await extractTelemetryLogs(body)
    expect(result[0]!.traceId).toBeDefined()
    // Should be hex, not base64
    expect(result[0]!.traceId).toMatch(/^[0-9a-f]+$/)
    // The base64 should convert to the correct hex
    expect(result[0]!.traceId).toBe('abcdef0123456789abcdef0123456789')
  })

  it('normalizes base64-encoded spanId to hex', async () => {
    // base64 of 8 bytes (16 hex chars spanId)
    // "q83vASNFZ4k=" is base64 for 0xabcdef0123456789
    const spanIdBase64 = 'q83vASNFZ4k='
    const body = makeResourceLogs({ spanId: spanIdBase64 })
    const result = await extractTelemetryLogs(body)
    expect(result[0]!.spanId).toBeDefined()
    expect(result[0]!.spanId).toMatch(/^[0-9a-f]+$/)
    expect(result[0]!.spanId).toBe('abcdef0123456789')
  })

  it('sets traceId/spanId to undefined when not present', async () => {
    const body = makeResourceLogs({})
    const result = await extractTelemetryLogs(body)
    expect(result[0]!.traceId).toBeUndefined()
    expect(result[0]!.spanId).toBeUndefined()
  })

  it('computes bodyHash as 16-char hex string', async () => {
    const body = makeResourceLogs({ bodyString: 'Connection refused to 10.0.1.5:5432' })
    const result = await extractTelemetryLogs(body)
    expect(result[0]!.bodyHash).toHaveLength(16)
    expect(result[0]!.bodyHash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('produces same bodyHash for structurally identical messages', async () => {
    const body1 = makeResourceLogs({ bodyString: 'Connection refused to 10.0.1.5:5432 after 3000ms' })
    const body2 = makeResourceLogs({ bodyString: 'Connection refused to 10.0.1.6:5432 after 5000ms' })
    const result1 = await extractTelemetryLogs(body1)
    const result2 = await extractTelemetryLogs(body2)
    expect(result1[0]!.bodyHash).toBe(result2[0]!.bodyHash)
  })

  it('falls back to observedTimeUnixNano when timeUnixNano is missing', async () => {
    const body = {
      resourceLogs: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'svc-a' } },
            { key: 'deployment.environment.name', value: { stringValue: 'production' } },
          ],
        },
        scopeLogs: [{
          logRecords: [{
            observedTimeUnixNano: BASE_TIME_NS,
            severityNumber: 17,
            body: { stringValue: 'fallback test' },
            attributes: [],
          }],
        }],
      }],
    }
    const result = await extractTelemetryLogs(body)
    expect(result).toHaveLength(1)
    expect(result[0]!.startTimeMs).toBe(BASE_TIME_MS)
  })

  it('excludes logs with no timestamp', async () => {
    const body = {
      resourceLogs: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc' } }] },
        scopeLogs: [{
          logRecords: [{
            severityNumber: 17,
            body: { stringValue: 'error msg' },
          }],
        }],
      }],
    }
    expect(await extractTelemetryLogs(body)).toHaveLength(0)
  })

  it('returns empty array for non-object input', async () => {
    expect(await extractTelemetryLogs(null)).toHaveLength(0)
    expect(await extractTelemetryLogs('bad')).toHaveLength(0)
  })

  it('returns empty array for empty resourceLogs', async () => {
    expect(await extractTelemetryLogs({ resourceLogs: [] })).toHaveLength(0)
  })

  it('extracts attributes as key-value map', async () => {
    const body = makeResourceLogs({
      attributes: [
        { key: 'orderId', value: { stringValue: 'ord_001' } },
        { key: 'userId', value: { stringValue: 'usr_002' } },
      ],
    })
    const result = await extractTelemetryLogs(body)
    expect(result[0]!.attributes).toMatchObject({
      orderId: expect.anything(),
      userId: expect.anything(),
    })
  })

  it('sets ingestedAt to approximately current time', async () => {
    const before = Date.now()
    const body = makeResourceLogs({})
    const result = await extractTelemetryLogs(body)
    const after = Date.now()
    expect(result[0]!.ingestedAt).toBeGreaterThanOrEqual(before)
    expect(result[0]!.ingestedAt).toBeLessThanOrEqual(after)
  })

  it('JSON.stringify non-string body values', async () => {
    const body = makeResourceLogs({ bodyOther: { kvlistValue: { values: [] } } })
    const result = await extractTelemetryLogs(body)
    expect(result).toHaveLength(1)
    expect(typeof result[0]!.body).toBe('string')
    expect(result[0]!.body).toContain('kvlistValue')
  })
})
