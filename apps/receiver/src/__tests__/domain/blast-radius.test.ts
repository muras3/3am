/**
 * Tests for blast-radius.ts — per-service error rate computation.
 *
 * Uses MemoryTelemetryAdapter as the TelemetryStoreDriver implementation.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryTelemetryAdapter } from '../../telemetry/adapters/memory.js'
import { computeBlastRadius } from '../../domain/blast-radius.js'
import type { TelemetrySpan } from '../../telemetry/interface.js'
import type { TelemetryScope } from '../../storage/interface.js'

// ── Test helpers ─────────────────────────────────────────────────────────

const BASE_TIME_MS = 1741392000000 // 2025-03-07T16:00:00Z

function makeScope(overrides: Partial<TelemetryScope> = {}): TelemetryScope {
  return {
    windowStartMs: BASE_TIME_MS,
    windowEndMs: BASE_TIME_MS + 60_000,
    detectTimeMs: BASE_TIME_MS,
    environment: 'production',
    memberServices: ['web', 'payment-service', 'user-service'],
    dependencyServices: [],
    ...overrides,
  }
}

function makeSpan(overrides: Partial<TelemetrySpan> = {}): TelemetrySpan {
  return {
    traceId: 'trace001',
    spanId: 'span001',
    serviceName: 'web',
    environment: 'production',
    spanName: 'GET /api/users',
    httpStatusCode: 200,
    spanStatusCode: 1,
    durationMs: 50,
    startTimeMs: BASE_TIME_MS + 1000,
    exceptionCount: 0,
    attributes: {},
    ingestedAt: Date.now(),
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('computeBlastRadius', () => {
  let telemetryStore: MemoryTelemetryAdapter
  let scope: TelemetryScope

  beforeEach(() => {
    telemetryStore = new MemoryTelemetryAdapter()
    scope = makeScope()
  })

  it('single service with high error rate returns "critical" status', async () => {
    // 8 out of 10 spans are errors → 80% error rate → critical
    const spans: TelemetrySpan[] = []
    for (let i = 0; i < 10; i++) {
      spans.push(makeSpan({
        traceId: `trace${i}`,
        spanId: `span${i}`,
        serviceName: 'payment-service',
        httpStatusCode: i < 8 ? 500 : 200,
        spanStatusCode: i < 8 ? 2 : 1,
        startTimeMs: BASE_TIME_MS + i * 1000,
      }))
    }
    await telemetryStore.ingestSpans(spans)

    scope = makeScope({ memberServices: ['payment-service'] })
    const result = await computeBlastRadius(telemetryStore, scope)

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toEqual({
      targetId: 'service:payment-service',
      label: 'payment-service',
      status: 'critical',
      impactMetric: 'error_rate',
      impactValue: 0.8,
      displayValue: '80%',
    })
    expect(result.rollup.healthyCount).toBe(0)
  })

  it('multiple services with mixed health are sorted by impactValue desc, healthy in rollup', async () => {
    const spans: TelemetrySpan[] = []

    // payment-service: 6/10 errors = 60% → critical
    for (let i = 0; i < 10; i++) {
      spans.push(makeSpan({
        traceId: `pay-trace${i}`,
        spanId: `pay-span${i}`,
        serviceName: 'payment-service',
        httpStatusCode: i < 6 ? 500 : 200,
        spanStatusCode: i < 6 ? 2 : 1,
        startTimeMs: BASE_TIME_MS + i * 1000,
      }))
    }

    // user-service: 2/100 errors = 2% → degraded
    for (let i = 0; i < 100; i++) {
      spans.push(makeSpan({
        traceId: `user-trace${i}`,
        spanId: `user-span${i}`,
        serviceName: 'user-service',
        httpStatusCode: i < 2 ? 503 : 200,
        spanStatusCode: i < 2 ? 2 : 1,
        startTimeMs: BASE_TIME_MS + (i % 60) * 1000,
      }))
    }

    // web: 0/50 errors = 0% → healthy
    for (let i = 0; i < 50; i++) {
      spans.push(makeSpan({
        traceId: `web-trace${i}`,
        spanId: `web-span${i}`,
        serviceName: 'web',
        httpStatusCode: 200,
        spanStatusCode: 1,
        startTimeMs: BASE_TIME_MS + (i % 60) * 1000,
      }))
    }

    await telemetryStore.ingestSpans(spans)

    const result = await computeBlastRadius(telemetryStore, scope)

    // Only degraded/critical entries (sorted by impactValue desc)
    expect(result.entries).toHaveLength(2)
    expect(result.entries[0].targetId).toBe('service:payment-service')
    expect(result.entries[0].status).toBe('critical')
    expect(result.entries[0].impactValue).toBe(0.6)

    expect(result.entries[1].targetId).toBe('service:user-service')
    expect(result.entries[1].status).toBe('degraded')
    expect(result.entries[1].impactValue).toBe(0.02)

    // Healthy services go to rollup
    expect(result.rollup.healthyCount).toBe(1)
    expect(result.rollup.label).toBe('1 other services ok')
  })

  it('no spans returns empty entries and rollup healthyCount = 0', async () => {
    const result = await computeBlastRadius(telemetryStore, scope)

    expect(result.entries).toEqual([])
    expect(result.rollup).toEqual({
      healthyCount: 0,
      label: '0 other services ok',
    })
  })

  it('all healthy services return empty entries and all in rollup', async () => {
    const spans: TelemetrySpan[] = []

    // 3 services, all with 0% error rate
    for (const svc of ['web', 'payment-service', 'user-service']) {
      for (let i = 0; i < 10; i++) {
        spans.push(makeSpan({
          traceId: `${svc}-trace${i}`,
          spanId: `${svc}-span${i}`,
          serviceName: svc,
          httpStatusCode: 200,
          spanStatusCode: 1,
          startTimeMs: BASE_TIME_MS + i * 1000,
        }))
      }
    }
    await telemetryStore.ingestSpans(spans)

    const result = await computeBlastRadius(telemetryStore, scope)

    expect(result.entries).toEqual([])
    expect(result.rollup.healthyCount).toBe(3)
    expect(result.rollup.label).toBe('3 other services ok')
  })

  it('detects errors from HTTP 429 status code', async () => {
    const spans: TelemetrySpan[] = []
    // 5 out of 10 are 429 → 50% error rate → critical
    for (let i = 0; i < 10; i++) {
      spans.push(makeSpan({
        traceId: `trace${i}`,
        spanId: `span${i}`,
        serviceName: 'payment-service',
        httpStatusCode: i < 5 ? 429 : 200,
        spanStatusCode: 1, // 429 may not set OTel error status
        startTimeMs: BASE_TIME_MS + i * 1000,
      }))
    }
    await telemetryStore.ingestSpans(spans)

    scope = makeScope({ memberServices: ['payment-service'] })
    const result = await computeBlastRadius(telemetryStore, scope)

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].status).toBe('critical')
    expect(result.entries[0].impactValue).toBe(0.5)
  })

  it('detects errors from exceptionCount > 0', async () => {
    const spans: TelemetrySpan[] = []
    // 3 out of 10 have exceptions → 30% error rate → critical
    for (let i = 0; i < 10; i++) {
      spans.push(makeSpan({
        traceId: `trace${i}`,
        spanId: `span${i}`,
        serviceName: 'web',
        httpStatusCode: 200,
        spanStatusCode: 1,
        exceptionCount: i < 3 ? 1 : 0,
        startTimeMs: BASE_TIME_MS + i * 1000,
      }))
    }
    await telemetryStore.ingestSpans(spans)

    scope = makeScope({ memberServices: ['web'] })
    const result = await computeBlastRadius(telemetryStore, scope)

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].status).toBe('critical')
    expect(result.entries[0].impactValue).toBeCloseTo(0.3)
  })

  it('degraded threshold: error rate at exactly 1% is degraded', async () => {
    const spans: TelemetrySpan[] = []
    // 1 out of 100 is error → 1% → degraded
    for (let i = 0; i < 100; i++) {
      spans.push(makeSpan({
        traceId: `trace${i}`,
        spanId: `span${i}`,
        serviceName: 'web',
        httpStatusCode: i === 0 ? 500 : 200,
        spanStatusCode: i === 0 ? 2 : 1,
        startTimeMs: BASE_TIME_MS + (i % 60) * 1000,
      }))
    }
    await telemetryStore.ingestSpans(spans)

    scope = makeScope({ memberServices: ['web'] })
    const result = await computeBlastRadius(telemetryStore, scope)

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].status).toBe('degraded')
    expect(result.entries[0].impactValue).toBe(0.01)
    expect(result.entries[0].displayValue).toBe('1%')
  })
})
