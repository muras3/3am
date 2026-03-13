import { describe, it, expect } from 'vitest'
import { IncidentPacketSchema } from '@3amoncall/core'
import { buildAnomalousSignals, createPacket, rebuildPacket } from '../../domain/packetizer.js'
import { isAnomalous, type ExtractedSpan } from '../../domain/anomaly-detector.js'
import type { IncidentRawState } from '../../storage/interface.js'

const spans: ExtractedSpan[] = [
  {
    traceId: 'trace001',
    spanId: 'span001',
    serviceName: 'api-service',
    environment: 'production',
    httpRoute: '/checkout',
    httpStatusCode: 500,
    spanStatusCode: 2,
    durationMs: 1000,
    startTimeMs: 1700000000000,
    exceptionCount: 0,
    peerService: 'stripe',
  },
  {
    traceId: 'trace001',
    spanId: 'span002',
    serviceName: 'payment-service',
    environment: 'production',
    httpStatusCode: 200,
    spanStatusCode: 1,
    durationMs: 50,
    startTimeMs: 1700000000050,
    exceptionCount: 0,
  },
]

describe('createPacket', () => {
  const packet = createPacket('inc_test_001', '2023-11-14T22:13:20.000Z', spans)

  it('passes Zod schema validation', () => {
    expect(() => IncidentPacketSchema.parse(packet)).not.toThrow()
  })

  it('has correct schemaVersion', () => {
    expect(packet.schemaVersion).toBe('incident-packet/v1alpha1')
  })

  it('has the incidentId from the argument', () => {
    expect(packet.incidentId).toBe('inc_test_001')
  })

  it('scope.affectedServices contains both services', () => {
    expect(packet.scope.affectedServices).toContain('api-service')
    expect(packet.scope.affectedServices).toContain('payment-service')
  })

  it('triggerSignals has length 1 (only the 500 span)', () => {
    expect(packet.triggerSignals).toHaveLength(1)
  })

  it('triggerSignals[0].signal is "http_500"', () => {
    expect(packet.triggerSignals[0].signal).toBe('http_500')
  })

  it('evidence.representativeTraces has length 2 (all spans)', () => {
    expect(packet.evidence.representativeTraces).toHaveLength(2)
  })

  it('pointers.traceRefs contains "trace001" with no duplicates', () => {
    expect(packet.pointers.traceRefs).toContain('trace001')
    const unique = [...new Set(packet.pointers.traceRefs)]
    expect(unique).toHaveLength(packet.pointers.traceRefs.length)
  })

  it('scope.affectedDependencies includes peerService values (ADR 0023)', () => {
    expect(packet.scope.affectedDependencies).toContain('stripe')
  })

  it('scope.affectedDependencies excludes spans with no peerService', () => {
    // span002 has no peerService, so only 'stripe' from span001 should appear
    expect(packet.scope.affectedDependencies).toHaveLength(1)
  })

  it('evidence.representativeTraces has the correct typed shape', () => {
    const trace = packet.evidence.representativeTraces[0] as {
      traceId: string; spanId: string; serviceName: string;
      durationMs: number; spanStatusCode: number
    }
    expect(trace.traceId).toBe('trace001')
    expect(trace.spanId).toBe('span001')
    expect(trace.serviceName).toBe('api-service')
    expect(typeof trace.durationMs).toBe('number')
    expect(typeof trace.spanStatusCode).toBe('number')
  })
})

// ---

const makeRawState = (allSpans: ExtractedSpan[], signals?: IncidentRawState['anomalousSignals']): IncidentRawState => ({
  spans: allSpans,
  anomalousSignals: signals ?? buildAnomalousSignals(allSpans.filter(isAnomalous)),
  metricEvidence: [],
  logEvidence: [],
  platformEvents: [],
})

describe('rebuildPacket', () => {
  const rawState = makeRawState(spans)

  it('single batch raw state → valid packet', () => {
    const packet = rebuildPacket('inc_1', 'pkt_1', '2023-11-14T22:13:20.000Z', rawState)
    expect(() => IncidentPacketSchema.parse(packet)).not.toThrow()
    expect(packet.incidentId).toBe('inc_1')
    expect(packet.packetId).toBe('pkt_1')
  })

  it('generation defaults to 1 when not provided', () => {
    const packet = rebuildPacket('inc_1', 'pkt_1', '2023-11-14T22:13:20.000Z', rawState)
    expect(packet.generation).toBe(1)
  })

  it('generation counter is stored in packet', () => {
    const packet = rebuildPacket('inc_1', 'pkt_1', '2023-11-14T22:13:20.000Z', rawState, undefined, 3)
    expect(packet.generation).toBe(3)
  })

  it('existingEvidence is preserved in output', () => {
    const evidence = {
      changedMetrics: [{ name: 'p99', value: 2000 }],
      relevantLogs: [{ message: 'error log' }],
      platformEvents: [{ type: 'deploy' }],
    }
    const packet = rebuildPacket('inc_1', 'pkt_1', '2023-11-14T22:13:20.000Z', rawState, evidence)
    expect(packet.evidence.changedMetrics).toEqual(evidence.changedMetrics)
    expect(packet.evidence.relevantLogs).toEqual(evidence.relevantLogs)
    expect(packet.evidence.platformEvents).toEqual(evidence.platformEvents)
  })

  it('existingEvidence defaults to empty arrays when not provided', () => {
    const packet = rebuildPacket('inc_1', 'pkt_1', '2023-11-14T22:13:20.000Z', rawState)
    expect(packet.evidence.changedMetrics).toEqual([])
    expect(packet.evidence.relevantLogs).toEqual([])
    expect(packet.evidence.platformEvents).toEqual([])
  })

  it('multi-batch: merged triggerSignals are deduped, window is expanded', () => {
    const batch1Spans: ExtractedSpan[] = [
      {
        traceId: 'trace001', spanId: 'span001', serviceName: 'api-service',
        environment: 'production', httpStatusCode: 500, spanStatusCode: 2,
        durationMs: 1000, startTimeMs: 1700000000000, exceptionCount: 0,
      },
    ]
    const batch2Spans: ExtractedSpan[] = [
      {
        traceId: 'trace002', spanId: 'span002', serviceName: 'api-service',
        environment: 'production', httpStatusCode: 500, spanStatusCode: 2,
        durationMs: 500, startTimeMs: 1700000005000, exceptionCount: 0,
      },
      {
        traceId: 'trace003', spanId: 'span003', serviceName: 'worker-service',
        environment: 'production', httpStatusCode: 429, spanStatusCode: 1,
        durationMs: 200, startTimeMs: 1700000003000, exceptionCount: 0,
      },
    ]

    const allSpans = [...batch1Spans, ...batch2Spans]
    const allSignals: IncidentRawState['anomalousSignals'] = [
      { signal: 'http_500', firstSeenAt: new Date(1700000000000).toISOString(), entity: 'api-service', spanId: 'span001' },
      { signal: 'http_500', firstSeenAt: new Date(1700000005000).toISOString(), entity: 'api-service', spanId: 'span002' },
      { signal: 'http_429', firstSeenAt: new Date(1700000003000).toISOString(), entity: 'worker-service', spanId: 'span003' },
    ]

    const merged: IncidentRawState = {
      spans: allSpans,
      anomalousSignals: allSignals,
      metricEvidence: [],
      logEvidence: [],
      platformEvents: [],
    }

    const packet = rebuildPacket('inc_1', 'pkt_1', '2023-11-14T22:13:20.000Z', merged)

    // window is expanded
    expect(packet.window.start).toBe(new Date(1700000000000).toISOString())
    expect(packet.window.end).toBe(new Date(1700000005000 + 500).toISOString())

    // http_500 for api-service is deduped (only 1 entry)
    const http500 = packet.triggerSignals.filter((s) => s.signal === 'http_500' && s.entity === 'api-service')
    expect(http500).toHaveLength(1)

    // http_429 for worker-service is separate
    const http429 = packet.triggerSignals.filter((s) => s.signal === 'http_429' && s.entity === 'worker-service')
    expect(http429).toHaveLength(1)

    // total distinct entries
    expect(packet.triggerSignals).toHaveLength(2)

    // traceRefs from both batches
    expect(packet.pointers.traceRefs).toContain('trace001')
    expect(packet.pointers.traceRefs).toContain('trace002')
    expect(packet.pointers.traceRefs).toContain('trace003')
  })

  it('triggerSignals dedup: same signal+entity keeps earliest firstSeenAt', () => {
    const early = new Date(1700000000000).toISOString()
    const late = new Date(1700000010000).toISOString()

    const signals: IncidentRawState['anomalousSignals'] = [
      { signal: 'http_500', firstSeenAt: late, entity: 'api-service', spanId: 'span002' },
      { signal: 'http_500', firstSeenAt: early, entity: 'api-service', spanId: 'span001' },
    ]

    const raw: IncidentRawState = {
      spans: spans,
      anomalousSignals: signals,
      metricEvidence: [],
      logEvidence: [],
      platformEvents: [],
    }

    const packet = rebuildPacket('inc_1', 'pkt_1', '2023-11-14T22:13:20.000Z', raw)
    const http500 = packet.triggerSignals.filter((s) => s.signal === 'http_500' && s.entity === 'api-service')
    expect(http500).toHaveLength(1)
    expect(http500[0].firstSeenAt).toBe(early)
  })

  it('idempotency: same raw state → identical packet JSON', () => {
    const p1 = rebuildPacket('inc_1', 'pkt_1', '2023-11-14T22:13:20.000Z', rawState, undefined, 2)
    const p2 = rebuildPacket('inc_1', 'pkt_1', '2023-11-14T22:13:20.000Z', rawState, undefined, 2)
    expect(JSON.stringify(p1)).toBe(JSON.stringify(p2))
  })

  it('representativeTraces capped at 10 spans', () => {
    const manySpans: ExtractedSpan[] = Array.from({ length: 15 }, (_, i) => ({
      traceId: `trace${i}`,
      spanId: `span${i}`,
      serviceName: 'svc',
      environment: 'production',
      spanStatusCode: 1,
      durationMs: 100,
      startTimeMs: 1700000000000 + i * 1000,
      exceptionCount: 0,
    }))
    const raw = makeRawState(manySpans)
    const packet = rebuildPacket('inc_1', 'pkt_1', '2023-11-14T22:13:20.000Z', raw)
    expect(packet.evidence.representativeTraces).toHaveLength(10)
  })
})
