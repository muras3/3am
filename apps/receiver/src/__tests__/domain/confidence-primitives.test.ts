/**
 * Tests for confidence-primitives.ts — evidence coverage, correlations, baseline confidence.
 *
 * Uses MemoryTelemetryAdapter as the TelemetryStoreDriver implementation.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryTelemetryAdapter } from '../../telemetry/adapters/memory.js'
import { computeConfidencePrimitives } from '../../domain/confidence-primitives.js'
import type { TelemetrySpan, TelemetryMetric, TelemetryLog } from '../../telemetry/interface.js'
import type { TelemetryScope, AnomalousSignal } from '../../storage/interface.js'

// ── Test helpers ─────────────────────────────────────────────────────────

const BASE_TIME_MS = 1741392000000 // 2025-03-07T16:00:00Z

function makeScope(overrides: Partial<TelemetryScope> = {}): TelemetryScope {
  return {
    windowStartMs: BASE_TIME_MS,
    windowEndMs: BASE_TIME_MS + 60_000, // 1 minute incident
    detectTimeMs: BASE_TIME_MS,
    environment: 'production',
    memberServices: ['web'],
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

function makeMetric(overrides: Partial<TelemetryMetric> = {}): TelemetryMetric {
  return {
    service: 'web',
    environment: 'production',
    name: 'http.server.request.error_rate',
    startTimeMs: BASE_TIME_MS + 1000,
    summary: { asDouble: 0.85 },
    ingestedAt: Date.now(),
    ...overrides,
  }
}

function makeLog(overrides: Partial<TelemetryLog> = {}): TelemetryLog {
  return {
    service: 'web',
    environment: 'production',
    timestamp: new Date(BASE_TIME_MS + 1000).toISOString(),
    startTimeMs: BASE_TIME_MS + 1000,
    severity: 'ERROR',
    severityNumber: 17,
    body: 'Connection refused',
    bodyHash: 'abc123def456gh',
    attributes: {},
    ingestedAt: Date.now(),
    ...overrides,
  }
}

function makeSignal(overrides: Partial<AnomalousSignal> = {}): AnomalousSignal {
  return {
    signal: 'http_500',
    firstSeenAt: new Date(BASE_TIME_MS + 5000).toISOString(),
    entity: 'web',
    spanId: 'span001',
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('computeConfidencePrimitives', () => {
  let telemetryStore: MemoryTelemetryAdapter
  let scope: TelemetryScope

  beforeEach(() => {
    telemetryStore = new MemoryTelemetryAdapter()
    scope = makeScope()
  })

  describe('evidenceCoverage', () => {
    it('counts distinct traceIds, metrics, and logs from incident scope', async () => {
      // 3 spans from 2 distinct traces
      await telemetryStore.ingestSpans([
        makeSpan({ traceId: 'trace-A', spanId: 'span-1', startTimeMs: BASE_TIME_MS + 1000 }),
        makeSpan({ traceId: 'trace-A', spanId: 'span-2', startTimeMs: BASE_TIME_MS + 2000 }),
        makeSpan({ traceId: 'trace-B', spanId: 'span-3', startTimeMs: BASE_TIME_MS + 3000 }),
      ])

      // 4 metrics
      await telemetryStore.ingestMetrics([
        makeMetric({ name: 'error_rate', startTimeMs: BASE_TIME_MS + 1000 }),
        makeMetric({ name: 'error_rate', startTimeMs: BASE_TIME_MS + 2000 }),
        makeMetric({ name: 'latency_p99', startTimeMs: BASE_TIME_MS + 1000 }),
        makeMetric({ name: 'latency_p99', startTimeMs: BASE_TIME_MS + 2000 }),
      ])

      // 2 logs
      await telemetryStore.ingestLogs([
        makeLog({ startTimeMs: BASE_TIME_MS + 1000, bodyHash: 'hash1', timestamp: new Date(BASE_TIME_MS + 1000).toISOString() }),
        makeLog({ startTimeMs: BASE_TIME_MS + 2000, bodyHash: 'hash2', timestamp: new Date(BASE_TIME_MS + 2000).toISOString() }),
      ])

      const result = await computeConfidencePrimitives(
        telemetryStore, scope, [], [],
      )

      expect(result.evidenceCoverage.traceCount).toBe(2)
      expect(result.evidenceCoverage.metricCount).toBe(4)
      expect(result.evidenceCoverage.logCount).toBe(2)
    })

    it('counts baseline spans from before the incident window', async () => {
      // Baseline window: 4x incident duration before incident start
      // Incident: BASE_TIME_MS to BASE_TIME_MS + 60_000 (60s)
      // Baseline: BASE_TIME_MS - 300_000 to BASE_TIME_MS - 1 (min 5 min window)
      const baselineStart = BASE_TIME_MS - 300_000

      // Add 15 baseline spans
      const baselineSpans: TelemetrySpan[] = []
      for (let i = 0; i < 15; i++) {
        baselineSpans.push(makeSpan({
          traceId: `baseline-trace${i}`,
          spanId: `baseline-span${i}`,
          startTimeMs: baselineStart + i * 10000,
        }))
      }
      await telemetryStore.ingestSpans(baselineSpans)

      const result = await computeConfidencePrimitives(
        telemetryStore, scope, [], [],
      )

      expect(result.evidenceCoverage.baselineSampleCount).toBe(15)
    })
  })

  describe('correlations', () => {
    it('returns high correlation for temporally correlated metric and signals', async () => {
      // Create a 30-second incident window with 10 buckets (3s each)
      scope = makeScope({
        windowStartMs: BASE_TIME_MS,
        windowEndMs: BASE_TIME_MS + 30_000,
      })

      // Metrics that increase over time (bucket 0-9)
      const metrics: TelemetryMetric[] = []
      for (let i = 0; i < 10; i++) {
        metrics.push(makeMetric({
          name: 'http.server.error_count',
          startTimeMs: BASE_TIME_MS + i * 3000 + 500,
          summary: { asDouble: (i + 1) * 10 }, // increasing: 10, 20, 30, ...
        }))
      }
      await telemetryStore.ingestMetrics(metrics)

      // Anomalous signals also increasing over time
      const signals: AnomalousSignal[] = []
      for (let i = 0; i < 10; i++) {
        // More signals in later buckets
        const count = i < 3 ? 0 : i - 2 // 0,0,0,1,2,3,4,5,6,7
        for (let j = 0; j < count; j++) {
          signals.push(makeSignal({
            firstSeenAt: new Date(BASE_TIME_MS + i * 3000 + j * 100).toISOString(),
            spanId: `signal-span-${i}-${j}`,
          }))
        }
      }

      const result = await computeConfidencePrimitives(
        telemetryStore, scope, signals, [],
      )

      // Should have a correlation entry with high positive correlation
      expect(result.correlations.length).toBeGreaterThanOrEqual(1)
      const errorCorrelation = result.correlations.find(c => c.metricName === 'http.server.error_count')
      expect(errorCorrelation).toBeDefined()
      expect(errorCorrelation!.correlationValue).toBeGreaterThan(0.5)
      expect(errorCorrelation!.service).toBe('web')
    })

    it('returns empty correlations when no metrics', async () => {
      const signals = [makeSignal()]

      const result = await computeConfidencePrimitives(
        telemetryStore, scope, signals, [],
      )

      expect(result.correlations).toEqual([])
    })

    it('returns empty correlations when no anomalous signals', async () => {
      await telemetryStore.ingestMetrics([
        makeMetric({ startTimeMs: BASE_TIME_MS + 1000 }),
      ])

      const result = await computeConfidencePrimitives(
        telemetryStore, scope, [], [],
      )

      expect(result.correlations).toEqual([])
    })

    it('limits correlations to top 10', async () => {
      scope = makeScope({
        windowStartMs: BASE_TIME_MS,
        windowEndMs: BASE_TIME_MS + 30_000,
      })

      // Create 15 different metric names, all perfectly correlated
      const metrics: TelemetryMetric[] = []
      for (let metricIdx = 0; metricIdx < 15; metricIdx++) {
        for (let i = 0; i < 10; i++) {
          metrics.push(makeMetric({
            name: `metric_${metricIdx}`,
            startTimeMs: BASE_TIME_MS + i * 3000 + 500,
            summary: { asDouble: (i + 1) * 10 },
          }))
        }
      }
      await telemetryStore.ingestMetrics(metrics)

      // Signals also increase over time
      const signals: AnomalousSignal[] = []
      for (let i = 0; i < 10; i++) {
        for (let j = 0; j <= i; j++) {
          signals.push(makeSignal({
            firstSeenAt: new Date(BASE_TIME_MS + i * 3000 + j * 100).toISOString(),
            spanId: `sig-${i}-${j}`,
          }))
        }
      }

      const result = await computeConfidencePrimitives(
        telemetryStore, scope, signals, [],
      )

      expect(result.correlations.length).toBeLessThanOrEqual(10)
    })
  })

  describe('baselineConfidence', () => {
    it('>= 30 baseline spans → "high"', async () => {
      const baselineStart = BASE_TIME_MS - 300_000
      const spans: TelemetrySpan[] = []
      for (let i = 0; i < 35; i++) {
        spans.push(makeSpan({
          traceId: `bl-${i}`,
          spanId: `bl-span-${i}`,
          startTimeMs: baselineStart + i * 5000,
        }))
      }
      await telemetryStore.ingestSpans(spans)

      const result = await computeConfidencePrimitives(
        telemetryStore, scope, [], [],
      )

      expect(result.baselineConfidence).toBe('high')
    })

    it('>= 10 and < 30 baseline spans → "medium"', async () => {
      const baselineStart = BASE_TIME_MS - 300_000
      const spans: TelemetrySpan[] = []
      for (let i = 0; i < 15; i++) {
        spans.push(makeSpan({
          traceId: `bl-${i}`,
          spanId: `bl-span-${i}`,
          startTimeMs: baselineStart + i * 10000,
        }))
      }
      await telemetryStore.ingestSpans(spans)

      const result = await computeConfidencePrimitives(
        telemetryStore, scope, [], [],
      )

      expect(result.baselineConfidence).toBe('medium')
    })

    it('>= 1 and < 10 baseline spans → "low"', async () => {
      const baselineStart = BASE_TIME_MS - 300_000
      const spans: TelemetrySpan[] = []
      for (let i = 0; i < 3; i++) {
        spans.push(makeSpan({
          traceId: `bl-${i}`,
          spanId: `bl-span-${i}`,
          startTimeMs: baselineStart + i * 50000,
        }))
      }
      await telemetryStore.ingestSpans(spans)

      const result = await computeConfidencePrimitives(
        telemetryStore, scope, [], [],
      )

      expect(result.baselineConfidence).toBe('low')
    })

    it('0 baseline spans → "unavailable"', async () => {
      const result = await computeConfidencePrimitives(
        telemetryStore, scope, [], [],
      )

      expect(result.baselineConfidence).toBe('unavailable')
    })
  })

  describe('empty data', () => {
    it('returns unavailable confidence and zero counts with no data', async () => {
      const result = await computeConfidencePrimitives(
        telemetryStore, scope, [], [],
      )

      expect(result.evidenceCoverage).toEqual({
        traceCount: 0,
        metricCount: 0,
        logCount: 0,
        baselineSampleCount: 0,
      })
      expect(result.correlations).toEqual([])
      expect(result.baselineConfidence).toBe('unavailable')
    })
  })
})
