import { describe, it, expect } from 'vitest'
import {
  extractMetricEvidence,
  extractLogEvidence,
  shouldAttachEvidence,
} from '../../domain/evidence-extractor.js'
import type { Incident } from '../../storage/interface.js'
import { FORMATION_WINDOW_MS } from '../../domain/formation.js'
import { createPacket } from '../../domain/packetizer.js'
import type { ExtractedSpan } from '../../domain/anomaly-detector.js'

// ── Fixtures ───────────────────────────────────────────────────────────────

const BASE_TIME_NS = '1741392000000000000' // 2025-03-07T16:00:00Z as nano string
const BASE_TIME_MS = 1741392000000

function makeResourceMetrics(overrides: {
  serviceName?: string
  environment?: string
  metricName?: string
  histDatapoint?: object
  gaugeDatapoint?: object
}) {
  const {
    serviceName = 'svc-a',
    environment = 'production',
    metricName = 'http.server.request.duration',
    histDatapoint,
    gaugeDatapoint,
  } = overrides

  const metrics: object[] = []
  if (histDatapoint !== undefined) {
    metrics.push({ name: metricName, histogram: { dataPoints: [histDatapoint] } })
  } else if (gaugeDatapoint !== undefined) {
    metrics.push({ name: metricName, gauge: { dataPoints: [gaugeDatapoint] } })
  } else {
    metrics.push({
      name: metricName,
      histogram: {
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
      },
    })
  }

  return {
    resourceMetrics: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: serviceName } },
          { key: 'deployment.environment.name', value: { stringValue: environment } },
        ],
      },
      scopeMetrics: [{ metrics }],
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
}) {
  const {
    serviceName = 'svc-a',
    environment = 'production',
    severityNumber = 17, // ERROR
    bodyString,
    bodyOther,
    timeUnixNano = BASE_TIME_NS,
  } = overrides

  const body = bodyString !== undefined
    ? { stringValue: bodyString }
    : bodyOther !== undefined ? bodyOther : { stringValue: 'checkout failed' }

  return {
    resourceLogs: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: serviceName } },
          { key: 'deployment.environment.name', value: { stringValue: environment } },
        ],
      },
      scopeLogs: [{
        logRecords: [{
          timeUnixNano,
          severityNumber,
          severityText: severityNumber >= 21 ? 'FATAL' : severityNumber >= 17 ? 'ERROR' : 'WARN',
          body,
          attributes: [
            { key: 'orderId', value: { stringValue: 'ord_001' } },
          ],
        }],
      }],
    }],
  }
}

const BASE_SPAN: ExtractedSpan = {
  traceId: 'abc',
  spanId: 'def',
  serviceName: 'svc-a',
  environment: 'production',
  httpStatusCode: 500,
  spanStatusCode: 2,
  durationMs: 100,
  startTimeMs: BASE_TIME_MS,
  exceptionCount: 0,
  peerService: 'stripe',
}

function makeIncident(): Incident {
  const packet = createPacket('inc_test', new Date(BASE_TIME_MS).toISOString(), [BASE_SPAN])
  return {
    incidentId: 'inc_test',
    status: 'open',
    openedAt: new Date(BASE_TIME_MS).toISOString(),
    packet,
  }
}

// ── extractMetricEvidence ──────────────────────────────────────────────────

describe('extractMetricEvidence', () => {
  it('extracts a histogram metric and compresses the datapoint', () => {
    const body = makeResourceMetrics({})
    const result = extractMetricEvidence(body)

    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('http.server.request.duration')
    expect(result[0].service).toBe('svc-a')
    expect(result[0].environment).toBe('production')
    expect(result[0].startTimeMs).toBe(BASE_TIME_MS)

    // histogram summary must include count/sum/min/max but NOT bucket arrays
    const summary = result[0].summary as Record<string, unknown>
    expect(summary.count).toBe('42')
    expect(summary.sum).toBe(1234.5)
    expect(summary.min).toBe(1.0)
    expect(summary.max).toBe(99.0)
    expect(summary.bucketCounts).toBeUndefined()
    expect(summary.explicitBounds).toBeUndefined()
  })

  it('extracts a gauge metric', () => {
    const body = makeResourceMetrics({
      metricName: 'process.cpu.usage',
      gaugeDatapoint: {
        startTimeUnixNano: BASE_TIME_NS,
        timeUnixNano: BASE_TIME_NS,
        asDouble: 0.42,
      },
    })
    const result = extractMetricEvidence(body)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('process.cpu.usage')
    expect((result[0].summary as Record<string, unknown>).asDouble).toBe(0.42)
  })

  it('falls back to timeUnixNano when startTimeUnixNano is missing', () => {
    const body = makeResourceMetrics({
      histDatapoint: {
        timeUnixNano: BASE_TIME_NS,
        count: '5',
        sum: 100,
      },
    })
    const result = extractMetricEvidence(body)
    expect(result).toHaveLength(1)
    expect(result[0].startTimeMs).toBe(BASE_TIME_MS)
  })

  it('drops datapoints where both timestamp fields are missing', () => {
    const body = makeResourceMetrics({
      histDatapoint: { count: '5', sum: 100 },
    })
    const result = extractMetricEvidence(body)
    expect(result).toHaveLength(0)
  })

  it('returns empty array for empty resourceMetrics', () => {
    expect(extractMetricEvidence({ resourceMetrics: [] })).toHaveLength(0)
  })

  it('returns empty array for non-object input', () => {
    expect(extractMetricEvidence(null)).toHaveLength(0)
    expect(extractMetricEvidence('bad')).toHaveLength(0)
  })

  it('skips resources with no service.name', () => {
    const body = {
      resourceMetrics: [{
        resource: { attributes: [] },
        scopeMetrics: [{ metrics: [{ name: 'foo', gauge: { dataPoints: [{ timeUnixNano: BASE_TIME_NS, asDouble: 1 }] } }] }],
      }],
    }
    expect(extractMetricEvidence(body)).toHaveLength(0)
  })
})

// ── extractLogEvidence ─────────────────────────────────────────────────────

describe('extractLogEvidence', () => {
  it('extracts an ERROR log', () => {
    const body = makeResourceLogs({ severityNumber: 17, bodyString: 'checkout failed' })
    const result = extractLogEvidence(body)
    expect(result).toHaveLength(1)
    expect(result[0].severity).toBe('ERROR')
    expect(result[0].body).toBe('checkout failed')
    expect(result[0].service).toBe('svc-a')
    expect(result[0].environment).toBe('production')
    expect(result[0].attributes).toMatchObject({ orderId: expect.anything() })
  })

  it('extracts a WARN log (severityNumber 13)', () => {
    const body = makeResourceLogs({ severityNumber: 13 })
    const result = extractLogEvidence(body)
    expect(result).toHaveLength(1)
    expect(result[0].severity).toBe('WARN')
  })

  it('extracts a FATAL log (severityNumber 21)', () => {
    const body = makeResourceLogs({ severityNumber: 21 })
    const result = extractLogEvidence(body)
    expect(result).toHaveLength(1)
    expect(result[0].severity).toBe('FATAL')
  })

  it('excludes INFO logs (severityNumber 12)', () => {
    const body = makeResourceLogs({ severityNumber: 12 })
    expect(extractLogEvidence(body)).toHaveLength(0)
  })

  it('excludes DEBUG logs (severityNumber 5)', () => {
    const body = makeResourceLogs({ severityNumber: 5 })
    expect(extractLogEvidence(body)).toHaveLength(0)
  })

  it('excludes logs with missing severityNumber', () => {
    const body = {
      resourceLogs: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc' } }] },
        scopeLogs: [{ logRecords: [{ timeUnixNano: BASE_TIME_NS, body: { stringValue: 'msg' } }] }],
      }],
    }
    expect(extractLogEvidence(body)).toHaveLength(0)
  })

  it('JSON.stringify non-string body values', () => {
    const body = makeResourceLogs({ severityNumber: 17, bodyOther: { kvlistValue: { values: [] } } })
    const result = extractLogEvidence(body)
    expect(result).toHaveLength(1)
    expect(typeof result[0].body).toBe('string')
    expect(result[0].body).toContain('kvlistValue')
  })

  it('returns empty array for empty resourceLogs', () => {
    expect(extractLogEvidence({ resourceLogs: [] })).toHaveLength(0)
  })

  it('returns empty array for non-object input', () => {
    expect(extractLogEvidence(null)).toHaveLength(0)
  })

  it('excludes log records with no timeUnixNano and no observedTimeUnixNano', () => {
    const body = {
      resourceLogs: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc' } }] },
        scopeLogs: [{
          logRecords: [{
            // no timeUnixNano, no observedTimeUnixNano
            severityNumber: 17,
            body: { stringValue: 'error msg' },
          }],
        }],
      }],
    }
    expect(extractLogEvidence(body)).toHaveLength(0)
  })
})

// ── shouldAttachEvidence ───────────────────────────────────────────────────

describe('shouldAttachEvidence', () => {
  it('matches when service is primaryService and within window', () => {
    const incident = makeIncident()
    // primaryService is 'svc-a', environment 'production'
    expect(shouldAttachEvidence({ service: 'svc-a', environment: 'production', startTimeMs: BASE_TIME_MS + 1000 }, incident)).toBe(true)
  })

  it('matches when service is in affectedServices', () => {
    const incident = makeIncident()
    // createPacket includes all span serviceNames in affectedServices
    // Our span has serviceName 'svc-a', so affectedServices includes 'svc-a'
    expect(shouldAttachEvidence({ service: 'svc-a', environment: 'production', startTimeMs: BASE_TIME_MS }, incident)).toBe(true)
  })

  it('matches when service is in affectedDependencies (peerService)', () => {
    const incident = makeIncident()
    // peerService 'stripe' → affectedDependencies
    expect(shouldAttachEvidence({ service: 'stripe', environment: 'production', startTimeMs: BASE_TIME_MS + 100 }, incident)).toBe(true)
  })

  it('rejects closed incidents', () => {
    const incident = { ...makeIncident(), status: 'closed' as const }
    expect(shouldAttachEvidence({ service: 'svc-a', environment: 'production', startTimeMs: BASE_TIME_MS }, incident)).toBe(false)
  })

  it('rejects mismatched environment', () => {
    const incident = makeIncident()
    expect(shouldAttachEvidence({ service: 'svc-a', environment: 'staging', startTimeMs: BASE_TIME_MS }, incident)).toBe(false)
  })

  it('rejects unknown service', () => {
    const incident = makeIncident()
    expect(shouldAttachEvidence({ service: 'unknown-svc', environment: 'production', startTimeMs: BASE_TIME_MS }, incident)).toBe(false)
  })

  it('rejects evidence before incident opened (delta < 0)', () => {
    const incident = makeIncident()
    expect(shouldAttachEvidence({ service: 'svc-a', environment: 'production', startTimeMs: BASE_TIME_MS - 1 }, incident)).toBe(false)
  })

  it('rejects evidence after window (delta > FORMATION_WINDOW_MS)', () => {
    const incident = makeIncident()
    expect(shouldAttachEvidence({ service: 'svc-a', environment: 'production', startTimeMs: BASE_TIME_MS + FORMATION_WINDOW_MS + 1 }, incident)).toBe(false)
  })

  it('accepts evidence exactly at window boundary', () => {
    const incident = makeIncident()
    expect(shouldAttachEvidence({ service: 'svc-a', environment: 'production', startTimeMs: BASE_TIME_MS + FORMATION_WINDOW_MS }, incident)).toBe(true)
  })
})
