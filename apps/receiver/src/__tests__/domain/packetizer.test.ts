import { describe, it, expect } from 'vitest'
import { IncidentPacketSchema, type PlatformEvent } from '@3amoncall/core'
import {
  buildAnomalousSignals,
  buildPlatformLogRef,
  createPacket,
  deriveSignalSeverity,
  selectPrimaryService,
} from '../../domain/packetizer.js'
import { type ExtractedSpan } from '../../domain/anomaly-detector.js'
import type { AnomalousSignal } from '../../storage/interface.js'

function makeSpan(overrides: Partial<ExtractedSpan> = {}): ExtractedSpan {
  return {
    traceId: overrides.traceId ?? 'trace-default',
    spanId: overrides.spanId ?? 'span-default',
    serviceName: overrides.serviceName ?? 'api-service',
    environment: overrides.environment ?? 'production',
    httpRoute: overrides.httpRoute ?? '/checkout',
    httpStatusCode: overrides.httpStatusCode,
    spanStatusCode: overrides.spanStatusCode ?? 1,
    durationMs: overrides.durationMs ?? 100,
    startTimeMs: overrides.startTimeMs ?? 1700000000000,
    exceptionCount: overrides.exceptionCount ?? 0,
    peerService: overrides.peerService,
  }
}

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
  const { packet } = createPacket('inc_test_001', '2023-11-14T22:13:20.000Z', spans)

  it('passes Zod schema validation', () => {
    expect(() => IncidentPacketSchema.parse(packet)).not.toThrow()
  })

  it('has correct schemaVersion', () => {
    expect(packet.schemaVersion).toBe('incident-packet/v1alpha1')
  })

  it('has the incidentId from the argument', () => {
    expect(packet.incidentId).toBe('inc_test_001')
  })

  it('sets primaryService to the first anomalous service rather than the first span', () => {
    const reordered = [
      makeSpan({
        traceId: 'trace010',
        spanId: 'span010',
        serviceName: 'edge-proxy',
        startTimeMs: 1700000002000,
      }),
      makeSpan({
        traceId: 'trace011',
        spanId: 'span011',
        serviceName: 'checkout-api',
        startTimeMs: 1700000001000,
        httpStatusCode: 500,
        spanStatusCode: 2,
      }),
    ]

    expect(createPacket('inc_test_010', '2023-11-14T22:13:20.000Z', reordered).packet.scope.primaryService).toBe('checkout-api')
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

describe('selectPrimaryService', () => {
  it('is order-independent when only one anomalous service exists', () => {
    const expected = 'service-a'
    const variants: ExtractedSpan[][] = [
      [
        makeSpan({ serviceName: 'service-b', spanId: 'span-b1', startTimeMs: 1700000001000 }),
        makeSpan({ serviceName: expected, spanId: 'span-a1', startTimeMs: 1700000000500, httpStatusCode: 500, spanStatusCode: 2 }),
        makeSpan({ serviceName: 'service-c', spanId: 'span-c1', startTimeMs: 1700000002000 }),
      ],
      [
        makeSpan({ serviceName: expected, spanId: 'span-a2', startTimeMs: 1700000000500, httpStatusCode: 500, spanStatusCode: 2 }),
        makeSpan({ serviceName: 'service-b', spanId: 'span-b2', startTimeMs: 1700000001000 }),
        makeSpan({ serviceName: 'service-c', spanId: 'span-c2', startTimeMs: 1700000002000 }),
      ],
      [
        makeSpan({ serviceName: 'service-c', spanId: 'span-c3', startTimeMs: 1700000002000 }),
        makeSpan({ serviceName: 'service-b', spanId: 'span-b3', startTimeMs: 1700000001000 }),
        makeSpan({ serviceName: expected, spanId: 'span-a3', startTimeMs: 1700000000500, httpStatusCode: 500, spanStatusCode: 2 }),
      ],
    ]

    for (const spans of variants) {
      expect(selectPrimaryService(spans)).toBe(expected)
    }
  })

  it('chooses the earliest anomalous service by start time', () => {
    expect(
      selectPrimaryService([
        makeSpan({ serviceName: 'service-a', spanId: 'span-a', startTimeMs: 1700000000100, httpStatusCode: 500, spanStatusCode: 2 }),
        makeSpan({ serviceName: 'service-b', spanId: 'span-b', startTimeMs: 1700000000200, httpStatusCode: 500, spanStatusCode: 2 }),
      ]),
    ).toBe('service-a')

    expect(
      selectPrimaryService([
        makeSpan({ serviceName: 'service-b', spanId: 'span-b', startTimeMs: 1700000000100, httpStatusCode: 500, spanStatusCode: 2 }),
        makeSpan({ serviceName: 'service-a', spanId: 'span-a', startTimeMs: 1700000000200, httpStatusCode: 500, spanStatusCode: 2 }),
      ]),
    ).toBe('service-b')
  })

  it('breaks anomalous timestamp ties by service name', () => {
    const selected = selectPrimaryService([
      makeSpan({ serviceName: 'service-b', spanId: 'span-b', startTimeMs: 1700000000100, httpStatusCode: 500, spanStatusCode: 2 }),
      makeSpan({ serviceName: 'service-a', spanId: 'span-a', startTimeMs: 1700000000100, httpStatusCode: 500, spanStatusCode: 2 }),
    ])

    expect(selected).toBe('service-a')
  })

  it('ignores non-anomalous spans before anomalous upstream spans', () => {
    const selected = selectPrimaryService([
      makeSpan({ serviceName: 'downstream-cache', spanId: 'span-cache', startTimeMs: 1700000000100 }),
      makeSpan({ serviceName: 'checkout-api', spanId: 'span-api', startTimeMs: 1700000000200, httpStatusCode: 500, spanStatusCode: 2 }),
    ])

    expect(selected).toBe('checkout-api')
  })

  it('falls back to spans[0].serviceName only when no anomalous spans exist', () => {
    const selected = selectPrimaryService([
      makeSpan({ serviceName: 'frontend', spanId: 'span-front', startTimeMs: 1700000000100 }),
      makeSpan({ serviceName: 'checkout-api', spanId: 'span-api', startTimeMs: 1700000000200, spanStatusCode: 0 }),
    ])

    expect(selected).toBe('frontend')
  })
})

// =============================================================================
// createPacket returns initialMembership (ADR 0032)
// =============================================================================

describe('createPacket — initialMembership', () => {
  it('returns both packet and initialMembership', () => {
    const result = createPacket('inc_1', '2023-11-14T22:13:20.000Z', spans)
    expect(result.packet).toBeDefined()
    expect(result.initialMembership).toBeDefined()
  })

  it('packet passes Zod schema validation', () => {
    const { packet } = createPacket('inc_1', '2023-11-14T22:13:20.000Z', spans)
    expect(() => IncidentPacketSchema.parse(packet)).not.toThrow()
  })

  it('initialMembership.telemetryScope has valid window and services', () => {
    const { initialMembership } = createPacket('inc_1', '2023-11-14T22:13:20.000Z', spans)
    expect(initialMembership.telemetryScope.windowStartMs).toBeLessThanOrEqual(initialMembership.telemetryScope.windowEndMs)
    expect(initialMembership.telemetryScope.environment).toBe('production')
    expect(initialMembership.telemetryScope.memberServices).toContain('api-service')
  })

  it('initialMembership.spanMembership contains traceId:spanId pairs', () => {
    const { initialMembership } = createPacket('inc_1', '2023-11-14T22:13:20.000Z', spans)
    expect(initialMembership.spanMembership).toContain('trace001:span001')
    expect(initialMembership.spanMembership).toContain('trace001:span002')
  })

  it('initialMembership.anomalousSignals contains signals from anomalous spans', () => {
    const { initialMembership } = createPacket('inc_1', '2023-11-14T22:13:20.000Z', spans)
    expect(initialMembership.anomalousSignals.length).toBeGreaterThan(0)
    expect(initialMembership.anomalousSignals[0].signal).toBe('http_500')
  })

  it('initialMembership.telemetryScope.dependencyServices includes peerService values', () => {
    const { initialMembership } = createPacket('inc_1', '2023-11-14T22:13:20.000Z', spans)
    expect(initialMembership.telemetryScope.dependencyServices).toContain('stripe')
  })

  it('packet generation defaults to 1', () => {
    const { packet } = createPacket('inc_1', '2023-11-14T22:13:20.000Z', spans)
    expect(packet.generation).toBe(1)
  })
})

// =============================================================================
// buildAnomalousSignals
// =============================================================================

describe('buildAnomalousSignals', () => {
  it('maps http status to signal name', () => {
    const anomalousSpans = [
      makeSpan({ httpStatusCode: 500, spanStatusCode: 2, traceId: 't1', spanId: 's1' }),
      makeSpan({ httpStatusCode: 429, spanStatusCode: 0, traceId: 't2', spanId: 's2' }),
    ]
    const signals = buildAnomalousSignals(anomalousSpans)
    expect(signals[0].signal).toBe('http_500')
    expect(signals[1].signal).toBe('http_429')
  })

  it('maps exception to "exception" signal', () => {
    const anomalousSpans = [
      makeSpan({ exceptionCount: 3, spanStatusCode: 2, traceId: 't1', spanId: 's1' }),
    ]
    const signals = buildAnomalousSignals(anomalousSpans)
    expect(signals[0].signal).toBe('exception')
  })

  it('maps spanStatusCode=2 without httpStatusCode to "span_error"', () => {
    const anomalousSpans = [
      makeSpan({ spanStatusCode: 2, traceId: 't1', spanId: 's1' }),
    ]
    const signals = buildAnomalousSignals(anomalousSpans)
    expect(signals[0].signal).toBe('span_error')
  })
})

// =============================================================================
// buildPlatformLogRef
// =============================================================================

describe('buildPlatformLogRef', () => {
  it('uses eventId when present', () => {
    const event: PlatformEvent = {
      eventType: 'deploy',
      timestamp: '2026-01-01T00:00:00Z',
      environment: 'production',
      description: 'deploy',
      eventId: 'evt_123',
    }
    expect(buildPlatformLogRef(event)).toBe('evt_123')
  })

  it('falls back to timestamp:eventType:service when no eventId', () => {
    const event: PlatformEvent = {
      eventType: 'deploy',
      timestamp: '2026-01-01T00:00:00Z',
      environment: 'production',
      description: 'deploy',
      service: 'web',
    }
    expect(buildPlatformLogRef(event)).toBe('2026-01-01T00:00:00Z:deploy:web')
  })

  it('uses provider name when service is absent', () => {
    const event: PlatformEvent = {
      eventType: 'provider_incident',
      timestamp: '2026-01-01T00:00:00Z',
      environment: 'production',
      description: 'stripe outage',
      provider: 'stripe',
    }
    expect(buildPlatformLogRef(event)).toBe('2026-01-01T00:00:00Z:provider_incident:stripe')
  })

  it('uses "global" when neither service nor provider', () => {
    const event: PlatformEvent = {
      eventType: 'config_change',
      timestamp: '2026-01-01T00:00:00Z',
      environment: 'production',
      description: 'config update',
    }
    expect(buildPlatformLogRef(event)).toBe('2026-01-01T00:00:00Z:config_change:global')
  })
})

// =============================================================================
// deriveSignalSeverity unit tests
// =============================================================================

describe("deriveSignalSeverity", () => {
  function makeSignal(signal: string): AnomalousSignal {
    return { signal, firstSeenAt: "2026-01-01T00:00:00Z", entity: "web:/api", spanId: "s1" }
  }

  it("returns low when no signals and no logs", () => {
    expect(deriveSignalSeverity([], [], 1)).toBe("low")
  })

  it("returns medium for slow_span only", () => {
    expect(deriveSignalSeverity([makeSignal("slow_span")], [], 1)).toBe("medium")
  })

  it("returns high for http_429 alone", () => {
    expect(deriveSignalSeverity([makeSignal("http_429")], [], 1)).toBe("high")
  })

  it("returns high for http_500 alone (score 4)", () => {
    expect(deriveSignalSeverity([makeSignal("http_500")], [], 1)).toBe("high")
  })

  it("returns critical for http_500 + multi-service (score 4+2=6)", () => {
    expect(deriveSignalSeverity([makeSignal("http_500")], [], 3)).toBe("critical")
  })

  it("returns critical for http_500 + FATAL log (score 4+3=7)", () => {
    const fatalLog = { service: "web", environment: "prod", timestamp: "t", startTimeMs: 1, severity: "FATAL", body: "oom", attributes: {} }
    expect(deriveSignalSeverity([makeSignal("http_500")], [fatalLog], 1)).toBe("critical")
  })

  it("returns high for exception + span_error (score 2+2=4)", () => {
    expect(deriveSignalSeverity([makeSignal("exception"), makeSignal("span_error")], [], 1)).toBe("high")
  })

  it("returns high for FATAL log alone (score 3)", () => {
    const fatalLog = { service: "web", environment: "prod", timestamp: "t", startTimeMs: 1, severity: "FATAL", body: "oom", attributes: {} }
    expect(deriveSignalSeverity([], [fatalLog], 1)).toBe("high")
  })

  it("deduplicates signal types (multiple http_500 signals count once)", () => {
    const signals = [makeSignal("http_500"), makeSignal("http_500"), makeSignal("http_500")]
    expect(deriveSignalSeverity(signals, [], 1)).toBe("high") // score 4, not 12
  })

  it("scores mixed 5xx codes once (http_500 + http_502 = score 4, not 8)", () => {
    const signals = [makeSignal("http_500"), makeSignal("http_502")]
    expect(deriveSignalSeverity(signals, [], 1)).toBe("high") // score 4, not 8
  })

  it("counts affectedServices === 2 as +1", () => {
    // slow_span (1) + 2 services (1) = 2 → medium
    expect(deriveSignalSeverity([makeSignal("slow_span")], [], 2)).toBe("medium")
  })

  it("counts ERROR log as +1", () => {
    const errorLog = { service: "web", environment: "prod", timestamp: "t", startTimeMs: 1, severity: "ERROR", body: "fail", attributes: {} }
    // ERROR (1) alone = medium
    expect(deriveSignalSeverity([], [errorLog], 1)).toBe("medium")
  })
})
