import { describe, it, expect } from 'vitest'
import {
  scoreMetrics,
  extractMetricValue,
  classifyMetric,
  spearmanCorrelation,
} from '../../../telemetry/scoring/metric-scorer.js'
import type { TelemetryMetric } from '../../../telemetry/interface.js'
import type { AnomalousSignal } from '../../../storage/interface.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMetric(overrides: Partial<TelemetryMetric> = {}): TelemetryMetric {
  return {
    service: overrides.service ?? 'api-service',
    environment: overrides.environment ?? 'production',
    name: overrides.name ?? 'http.server.request.duration',
    startTimeMs: overrides.startTimeMs ?? 1700000000000,
    summary: overrides.summary ?? { asDouble: 100 },
    ingestedAt: overrides.ingestedAt ?? Date.now(),
  }
}

function makeSignal(overrides: Partial<AnomalousSignal> = {}): AnomalousSignal {
  return {
    signal: overrides.signal ?? 'http_500',
    firstSeenAt: overrides.firstSeenAt ?? new Date(1700000005000).toISOString(),
    entity: overrides.entity ?? 'api-service',
    spanId: overrides.spanId ?? 'span-001',
  }
}

const defaultWindow = { startMs: 1700000000000, endMs: 1700000060000 }

// ---------------------------------------------------------------------------
// extractMetricValue
// ---------------------------------------------------------------------------

describe('extractMetricValue', () => {
  it('extracts asDouble from gauge/sum', () => {
    expect(extractMetricValue({ asDouble: 42.5 })).toBe(42.5)
  })

  it('extracts asInt from gauge/sum', () => {
    expect(extractMetricValue({ asInt: 17 })).toBe(17)
  })

  it('prefers asDouble over asInt', () => {
    expect(extractMetricValue({ asDouble: 1.5, asInt: 2 })).toBe(1.5)
  })

  it('computes mean from histogram sum/count', () => {
    expect(extractMetricValue({ sum: 500, count: 10 })).toBe(50)
  })

  it('returns null for count=0 histogram', () => {
    expect(extractMetricValue({ sum: 500, count: 0 })).toBeNull()
  })

  it('returns null for empty summary', () => {
    expect(extractMetricValue({})).toBeNull()
  })

  it('returns null for non-numeric values', () => {
    expect(extractMetricValue({ asDouble: 'not-a-number' })).toBeNull()
  })

  it('handles histogram with min/max (still uses sum/count)', () => {
    expect(extractMetricValue({ sum: 300, count: 3, min: 50, max: 150 })).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// classifyMetric
// ---------------------------------------------------------------------------

describe('classifyMetric', () => {
  it('classifies error-rate patterns', () => {
    expect(classifyMetric('http.server.request.error_rate')).toBe('error_rate')
    expect(classifyMetric('service.fault.count')).toBe('error_rate')
    expect(classifyMetric('api.failures')).toBe('error_rate')
    expect(classifyMetric('http.4xx.count')).toBe('error_rate')
    expect(classifyMetric('http.5xx.count')).toBe('error_rate')
  })

  it('classifies latency patterns', () => {
    expect(classifyMetric('http.server.request.duration')).toBe('latency')
    expect(classifyMetric('api.latency.p99')).toBe('latency')
    expect(classifyMetric('service.response_time')).toBe('latency')
    expect(classifyMetric('db.query.p95')).toBe('latency')
  })

  it('classifies throughput patterns', () => {
    expect(classifyMetric('http.server.request.count')).toBe('throughput')
    expect(classifyMetric('api.request.rate')).toBe('throughput')
    expect(classifyMetric('service.throughput')).toBe('throughput')
  })

  it('classifies resource patterns', () => {
    expect(classifyMetric('process.runtime.memory')).toBe('resource')
    expect(classifyMetric('system.cpu.utilization')).toBe('resource')
    expect(classifyMetric('db.pool.connections')).toBe('resource')
    expect(classifyMetric('message.queue.depth')).toBe('resource')
    expect(classifyMetric('system.disk.usage')).toBe('resource')
  })

  it('returns unclassified for unknown patterns', () => {
    expect(classifyMetric('custom.metric.xyz')).toBe('unclassified')
  })

  it('is case-insensitive', () => {
    expect(classifyMetric('HTTP.SERVER.REQUEST.DURATION')).toBe('latency')
    expect(classifyMetric('Service.ERROR_RATE')).toBe('error_rate')
  })

  it('error_rate takes priority over throughput for names containing both patterns', () => {
    // "error" matches error_rate first, even though "count" would match throughput
    expect(classifyMetric('http.server.error.count')).toBe('error_rate')
  })
})

// ---------------------------------------------------------------------------
// spearmanCorrelation
// ---------------------------------------------------------------------------

describe('spearmanCorrelation', () => {
  it('returns 1.0 for perfectly correlated arrays', () => {
    const xs = [1, 2, 3, 4, 5]
    const ys = [10, 20, 30, 40, 50]
    expect(spearmanCorrelation(xs, ys)).toBeCloseTo(1.0)
  })

  it('returns -1.0 for perfectly inversely correlated arrays', () => {
    const xs = [1, 2, 3, 4, 5]
    const ys = [50, 40, 30, 20, 10]
    expect(spearmanCorrelation(xs, ys)).toBeCloseTo(-1.0)
  })

  it('returns ~0 for uncorrelated arrays', () => {
    // Use a known uncorrelated arrangement
    const xs = [1, 2, 3, 4, 5]
    const ys = [3, 1, 5, 2, 4]
    // Not exactly 0 but should be low
    const rho = spearmanCorrelation(xs, ys)
    expect(Math.abs(rho)).toBeLessThan(0.5)
  })

  it('returns NaN for length < 2', () => {
    expect(spearmanCorrelation([1], [2])).toBeNaN()
    expect(spearmanCorrelation([], [])).toBeNaN()
  })

  it('returns NaN for mismatched lengths', () => {
    expect(spearmanCorrelation([1, 2, 3], [1, 2])).toBeNaN()
  })

  it('handles ties correctly', () => {
    const xs = [1, 2, 2, 4]
    const ys = [1, 3, 3, 4]
    const rho = spearmanCorrelation(xs, ys)
    expect(rho).toBeCloseTo(1.0)
  })

  it('handles length 2', () => {
    expect(spearmanCorrelation([1, 2], [1, 2])).toBeCloseTo(1.0)
    expect(spearmanCorrelation([1, 2], [2, 1])).toBeCloseTo(-1.0)
  })
})

// ---------------------------------------------------------------------------
// scoreMetrics — z-score calculation
// ---------------------------------------------------------------------------

describe('scoreMetrics', () => {
  it('computes z-score against known baseline', () => {
    // Baseline: [90, 100, 110, 100] → mean=100, population stddev=sqrt(50)≈7.071
    // Incident: mean=130 → z = (130 - 100) / 7.071 ≈ 4.243
    // latency class weight = 0.8
    // final score ≈ 4.243 * 0.8 ≈ 3.394
    const baseline = [
      makeMetric({ startTimeMs: 1699999900000, summary: { asDouble: 90 } }),
      makeMetric({ startTimeMs: 1699999910000, summary: { asDouble: 100 } }),
      makeMetric({ startTimeMs: 1699999920000, summary: { asDouble: 110 } }),
      makeMetric({ startTimeMs: 1699999930000, summary: { asDouble: 100 } }),
    ]
    const incident = [
      makeMetric({ startTimeMs: 1700000000000, summary: { asDouble: 130 } }),
    ]

    const result = scoreMetrics(incident, baseline, [], defaultWindow)
    expect(result).toHaveLength(1)
    // z ≈ 30 / sqrt(50) ≈ 4.243, score ≈ 4.243 * 0.8 ≈ 3.394
    expect(result[0]!.score).toBeCloseTo(3.394, 1)
  })

  it('uses volume heuristic fallback when baseline < MIN_BASELINE_DATAPOINTS', () => {
    // Only 2 baseline datapoints (< 3 minimum)
    // Baseline mean=100, incident mean=200
    // Volume heuristic: |200-100|/100 = 1.0
    // latency class weight = 0.8
    // final score = 1.0 * 0.8 = 0.8
    const baseline = [
      makeMetric({ startTimeMs: 1699999900000, summary: { asDouble: 90 } }),
      makeMetric({ startTimeMs: 1699999910000, summary: { asDouble: 110 } }),
    ]
    const incident = [
      makeMetric({ startTimeMs: 1700000000000, summary: { asDouble: 200 } }),
    ]

    const result = scoreMetrics(incident, baseline, [], defaultWindow)
    expect(result).toHaveLength(1)
    expect(result[0]!.score).toBeCloseTo(0.8, 1)
  })

  it('uses volume heuristic when baseline stddev is zero', () => {
    // All baseline values are identical → stddev = 0
    // Baseline mean=100, incident mean=150
    // Volume heuristic: |150-100|/100 = 0.5
    // latency class weight = 0.8
    // final score = 0.5 * 0.8 = 0.4
    const baseline = [
      makeMetric({ startTimeMs: 1699999900000, summary: { asDouble: 100 } }),
      makeMetric({ startTimeMs: 1699999910000, summary: { asDouble: 100 } }),
      makeMetric({ startTimeMs: 1699999920000, summary: { asDouble: 100 } }),
    ]
    const incident = [
      makeMetric({ startTimeMs: 1700000000000, summary: { asDouble: 150 } }),
    ]

    const result = scoreMetrics(incident, baseline, [], defaultWindow)
    expect(result).toHaveLength(1)
    expect(result[0]!.score).toBeCloseTo(0.4, 1)
  })

  it('handles empty baseline (no baseline data)', () => {
    const incident = [
      makeMetric({ startTimeMs: 1700000000000, summary: { asDouble: 50 } }),
    ]

    const result = scoreMetrics(incident, [], [], defaultWindow)
    expect(result).toHaveLength(1)
    // No baseline mean → baseline mean=0 → volume heuristic: min(10, 50) * 0.8
    expect(result[0]!.score).toBeGreaterThan(0)
  })

  it('returns empty array for empty incident metrics', () => {
    const result = scoreMetrics([], [], [], defaultWindow)
    expect(result).toHaveLength(0)
  })

  it('handles single datapoint in both baseline and incident', () => {
    const baseline = [
      makeMetric({ startTimeMs: 1699999900000, summary: { asDouble: 100 } }),
    ]
    const incident = [
      makeMetric({ startTimeMs: 1700000000000, summary: { asDouble: 200 } }),
    ]

    const result = scoreMetrics(incident, baseline, [], defaultWindow)
    expect(result).toHaveLength(1)
    expect(result[0]!.score).toBeGreaterThan(0)
  })

  it('does not divide by zero when baseline stddev is 0', () => {
    const baseline = [
      makeMetric({ startTimeMs: 1699999900000, summary: { asDouble: 50 } }),
      makeMetric({ startTimeMs: 1699999910000, summary: { asDouble: 50 } }),
      makeMetric({ startTimeMs: 1699999920000, summary: { asDouble: 50 } }),
    ]
    const incident = [
      makeMetric({ startTimeMs: 1700000000000, summary: { asDouble: 100 } }),
    ]

    const result = scoreMetrics(incident, baseline, [], defaultWindow)
    expect(result).toHaveLength(1)
    expect(Number.isFinite(result[0]!.score)).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // Class weight
  // ---------------------------------------------------------------------------

  it('applies metric class weight to scoring', () => {
    // error_rate (weight=1.0) vs throughput (weight=0.6) with same z-score
    const errorBaseline = [
      makeMetric({ name: 'http.error_rate', startTimeMs: 1699999900000, summary: { asDouble: 90 } }),
      makeMetric({ name: 'http.error_rate', startTimeMs: 1699999910000, summary: { asDouble: 100 } }),
      makeMetric({ name: 'http.error_rate', startTimeMs: 1699999920000, summary: { asDouble: 110 } }),
    ]
    const throughputBaseline = [
      makeMetric({ name: 'http.request.count', startTimeMs: 1699999900000, summary: { asDouble: 90 } }),
      makeMetric({ name: 'http.request.count', startTimeMs: 1699999910000, summary: { asDouble: 100 } }),
      makeMetric({ name: 'http.request.count', startTimeMs: 1699999920000, summary: { asDouble: 110 } }),
    ]

    const errorIncident = [
      makeMetric({ name: 'http.error_rate', startTimeMs: 1700000000000, summary: { asDouble: 130 } }),
    ]
    const throughputIncident = [
      makeMetric({ name: 'http.request.count', startTimeMs: 1700000000000, summary: { asDouble: 130 } }),
    ]

    const errorResult = scoreMetrics(errorIncident, errorBaseline, [], defaultWindow)
    const throughputResult = scoreMetrics(throughputIncident, throughputBaseline, [], defaultWindow)

    expect(errorResult[0]!.score).toBeGreaterThan(throughputResult[0]!.score)
  })

  it('uses weight 0.5 for unclassified metrics', () => {
    const baseline = [
      makeMetric({ name: 'custom.xyz', startTimeMs: 1699999900000, summary: { asDouble: 90 } }),
      makeMetric({ name: 'custom.xyz', startTimeMs: 1699999910000, summary: { asDouble: 100 } }),
      makeMetric({ name: 'custom.xyz', startTimeMs: 1699999920000, summary: { asDouble: 110 } }),
    ]
    const incident = [
      makeMetric({ name: 'custom.xyz', startTimeMs: 1700000000000, summary: { asDouble: 130 } }),
    ]

    const result = scoreMetrics(incident, baseline, [], defaultWindow)
    expect(result).toHaveLength(1)
    // Baseline: [90, 100, 110] → mean=100, stddev=sqrt(200/3)≈8.165
    // z = (130-100)/8.165 ≈ 3.674, score = 3.674 * 0.5 ≈ 1.837
    expect(result[0]!.score).toBeCloseTo(1.837, 1)
  })

  // ---------------------------------------------------------------------------
  // Spearman correlation bonus
  // ---------------------------------------------------------------------------

  it('adds Spearman bonus when metric timestamps correlate with anomalous signals', () => {
    // Create temporally correlated metric datapoints and signals
    // Both spike together in the same time buckets
    const baseMs = 1700000000000
    const windowEnd = baseMs + 60000

    const signals: AnomalousSignal[] = [
      makeSignal({ firstSeenAt: new Date(baseMs + 5000).toISOString() }),
      makeSignal({ firstSeenAt: new Date(baseMs + 6000).toISOString() }),
      makeSignal({ firstSeenAt: new Date(baseMs + 7000).toISOString() }),
      makeSignal({ firstSeenAt: new Date(baseMs + 8000).toISOString() }),
      makeSignal({ firstSeenAt: new Date(baseMs + 9000).toISOString() }),
    ]

    // Metric datapoints that align with signal timestamps
    const incident = [
      makeMetric({ name: 'http.error_rate', startTimeMs: baseMs + 5000, summary: { asDouble: 120 } }),
      makeMetric({ name: 'http.error_rate', startTimeMs: baseMs + 6000, summary: { asDouble: 130 } }),
      makeMetric({ name: 'http.error_rate', startTimeMs: baseMs + 7000, summary: { asDouble: 140 } }),
      makeMetric({ name: 'http.error_rate', startTimeMs: baseMs + 8000, summary: { asDouble: 150 } }),
      makeMetric({ name: 'http.error_rate', startTimeMs: baseMs + 9000, summary: { asDouble: 160 } }),
    ]

    const baseline = [
      makeMetric({ name: 'http.error_rate', startTimeMs: baseMs - 60000, summary: { asDouble: 90 } }),
      makeMetric({ name: 'http.error_rate', startTimeMs: baseMs - 50000, summary: { asDouble: 100 } }),
      makeMetric({ name: 'http.error_rate', startTimeMs: baseMs - 40000, summary: { asDouble: 110 } }),
    ]

    const withBonus = scoreMetrics(
      incident, baseline, signals,
      { startMs: baseMs, endMs: windowEnd },
    )

    // Same computation without signals
    const withoutBonus = scoreMetrics(
      incident, baseline, [],
      { startMs: baseMs, endMs: windowEnd },
    )

    expect(withBonus[0]!.score).toBeGreaterThanOrEqual(withoutBonus[0]!.score)
  })

  it('does not add Spearman bonus when metric has < 5 datapoints', () => {
    const baseMs = 1700000000000
    const signals: AnomalousSignal[] = [
      makeSignal({ firstSeenAt: new Date(baseMs + 5000).toISOString() }),
      makeSignal({ firstSeenAt: new Date(baseMs + 6000).toISOString() }),
    ]

    const incident = [
      makeMetric({ name: 'http.error_rate', startTimeMs: baseMs + 5000, summary: { asDouble: 120 } }),
      makeMetric({ name: 'http.error_rate', startTimeMs: baseMs + 6000, summary: { asDouble: 130 } }),
    ]

    const baseline = [
      makeMetric({ name: 'http.error_rate', startTimeMs: baseMs - 60000, summary: { asDouble: 90 } }),
      makeMetric({ name: 'http.error_rate', startTimeMs: baseMs - 50000, summary: { asDouble: 100 } }),
      makeMetric({ name: 'http.error_rate', startTimeMs: baseMs - 40000, summary: { asDouble: 110 } }),
    ]

    const withSignals = scoreMetrics(
      incident, baseline, signals,
      { startMs: baseMs, endMs: baseMs + 60000 },
    )
    const withoutSignals = scoreMetrics(
      incident, baseline, [],
      { startMs: baseMs, endMs: baseMs + 60000 },
    )

    // Should be the same since < 5 datapoints → no bonus
    expect(withSignals[0]!.score).toBeCloseTo(withoutSignals[0]!.score)
  })

  // ---------------------------------------------------------------------------
  // Grouping and sorting
  // ---------------------------------------------------------------------------

  it('groups incident metrics by (service, name)', () => {
    const baseline = [
      makeMetric({ service: 'svc-a', name: 'metric-1', startTimeMs: 1699999900000, summary: { asDouble: 100 } }),
      makeMetric({ service: 'svc-a', name: 'metric-1', startTimeMs: 1699999910000, summary: { asDouble: 100 } }),
      makeMetric({ service: 'svc-a', name: 'metric-1', startTimeMs: 1699999920000, summary: { asDouble: 100 } }),
    ]
    const incident = [
      makeMetric({ service: 'svc-a', name: 'metric-1', startTimeMs: 1700000000000, summary: { asDouble: 200 } }),
      makeMetric({ service: 'svc-a', name: 'metric-1', startTimeMs: 1700000010000, summary: { asDouble: 210 } }),
      makeMetric({ service: 'svc-b', name: 'metric-1', startTimeMs: 1700000000000, summary: { asDouble: 150 } }),
    ]

    const result = scoreMetrics(incident, baseline, [], defaultWindow)
    // Two groups: svc-a|metric-1 and svc-b|metric-1
    expect(result).toHaveLength(2)
  })

  it('sorts results by score descending', () => {
    const baseline = [
      makeMetric({ name: 'http.error_rate', startTimeMs: 1699999900000, summary: { asDouble: 100 } }),
      makeMetric({ name: 'http.error_rate', startTimeMs: 1699999910000, summary: { asDouble: 100 } }),
      makeMetric({ name: 'http.error_rate', startTimeMs: 1699999920000, summary: { asDouble: 100 } }),
      makeMetric({ name: 'http.request.count', startTimeMs: 1699999900000, summary: { asDouble: 100 } }),
      makeMetric({ name: 'http.request.count', startTimeMs: 1699999910000, summary: { asDouble: 100 } }),
      makeMetric({ name: 'http.request.count', startTimeMs: 1699999920000, summary: { asDouble: 100 } }),
    ]
    const incident = [
      makeMetric({ name: 'http.error_rate', startTimeMs: 1700000000000, summary: { asDouble: 200 } }),
      makeMetric({ name: 'http.request.count', startTimeMs: 1700000000000, summary: { asDouble: 200 } }),
    ]

    const result = scoreMetrics(incident, baseline, [], defaultWindow)
    expect(result).toHaveLength(2)
    // error_rate (weight=1.0) should score higher than throughput (weight=0.6)
    expect(result[0]!.name).toBe('http.error_rate')
    expect(result[1]!.name).toBe('http.request.count')
    expect(result[0]!.score).toBeGreaterThan(result[1]!.score)
  })

  // ---------------------------------------------------------------------------
  // Metric summary shapes
  // ---------------------------------------------------------------------------

  it('handles histogram summary shapes', () => {
    const baseline = [
      makeMetric({ startTimeMs: 1699999900000, summary: { sum: 300, count: 3, min: 80, max: 120 } }),
      makeMetric({ startTimeMs: 1699999910000, summary: { sum: 300, count: 3, min: 80, max: 120 } }),
      makeMetric({ startTimeMs: 1699999920000, summary: { sum: 300, count: 3, min: 80, max: 120 } }),
    ]
    const incident = [
      makeMetric({ startTimeMs: 1700000000000, summary: { sum: 600, count: 3, min: 180, max: 220 } }),
    ]

    const result = scoreMetrics(incident, baseline, [], defaultWindow)
    expect(result).toHaveLength(1)
    expect(result[0]!.score).toBeGreaterThan(0)
  })

  it('skips metrics with non-extractable values', () => {
    const incident = [
      makeMetric({ startTimeMs: 1700000000000, summary: { unknown: 'field' } }),
    ]

    const result = scoreMetrics(incident, [], [], defaultWindow)
    expect(result).toHaveLength(0)
  })

  // ---------------------------------------------------------------------------
  // Multiple metrics from different services
  // ---------------------------------------------------------------------------

  it('scores metrics from multiple services independently', () => {
    const baseMsSvc1 = 1699999900000
    const baseMsSvc2 = 1699999900000

    const baseline = [
      makeMetric({ service: 'api-service', name: 'http.server.request.duration', startTimeMs: baseMsSvc1, summary: { asDouble: 100 } }),
      makeMetric({ service: 'api-service', name: 'http.server.request.duration', startTimeMs: baseMsSvc1 + 10000, summary: { asDouble: 100 } }),
      makeMetric({ service: 'api-service', name: 'http.server.request.duration', startTimeMs: baseMsSvc1 + 20000, summary: { asDouble: 100 } }),
      makeMetric({ service: 'payment-service', name: 'http.server.request.duration', startTimeMs: baseMsSvc2, summary: { asDouble: 50 } }),
      makeMetric({ service: 'payment-service', name: 'http.server.request.duration', startTimeMs: baseMsSvc2 + 10000, summary: { asDouble: 50 } }),
      makeMetric({ service: 'payment-service', name: 'http.server.request.duration', startTimeMs: baseMsSvc2 + 20000, summary: { asDouble: 50 } }),
    ]

    const incident = [
      makeMetric({ service: 'api-service', name: 'http.server.request.duration', startTimeMs: 1700000000000, summary: { asDouble: 200 } }),
      makeMetric({ service: 'payment-service', name: 'http.server.request.duration', startTimeMs: 1700000000000, summary: { asDouble: 200 } }),
    ]

    const result = scoreMetrics(incident, baseline, [], defaultWindow)
    expect(result).toHaveLength(2)

    // payment-service has a larger deviation (200 vs 50 baseline) than api-service (200 vs 100 baseline)
    const paymentResult = result.find(r => r.service === 'payment-service')
    const apiResult = result.find(r => r.service === 'api-service')
    expect(paymentResult).toBeDefined()
    expect(apiResult).toBeDefined()
    // payment z-score is higher → should score higher
    expect(paymentResult!.score).toBeGreaterThan(apiResult!.score)

  })
})
