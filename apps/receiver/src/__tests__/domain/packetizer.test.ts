import { describe, it, expect } from 'vitest'
import { IncidentPacketSchema } from '@3amoncall/core'
import { createPacket } from '../../domain/packetizer.js'
import type { ExtractedSpan } from '../../domain/anomaly-detector.js'

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
})
