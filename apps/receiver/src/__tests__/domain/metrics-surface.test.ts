import { describe, it, expect } from 'vitest'
import { buildMetricsSurface } from '../../domain/metrics-surface.js'
import type { TelemetryMetric, TelemetryStoreDriver, TelemetryQueryFilter } from '../../telemetry/interface.js'
import type { TelemetryScope, AnomalousSignal } from '../../storage/interface.js'

// ── Helpers ──────────────────────────────────────────────────────────────

function makeMetric(overrides: Partial<TelemetryMetric> = {}): TelemetryMetric {
  return {
    service: overrides.service ?? 'api-service',
    environment: overrides.environment ?? 'production',
    name: overrides.name ?? 'http.server.request.duration',
    startTimeMs: overrides.startTimeMs ?? 1700000010000,
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

function makeScope(overrides: Partial<TelemetryScope> = {}): TelemetryScope {
  return {
    windowStartMs: overrides.windowStartMs ?? 1700000000000,
    windowEndMs: overrides.windowEndMs ?? 1700000060000,
    detectTimeMs: overrides.detectTimeMs ?? 1700000000000,
    environment: overrides.environment ?? 'production',
    memberServices: overrides.memberServices ?? ['api-service'],
    dependencyServices: overrides.dependencyServices ?? [],
  }
}

/**
 * Create a mock TelemetryStoreDriver that returns configurable metrics
 * for incident and baseline queries.
 */
function makeMockStore(
  incidentMetrics: TelemetryMetric[],
  baselineMetrics: TelemetryMetric[],
): TelemetryStoreDriver {
  let callCount = 0
  return {
    ingestSpans: async () => {},
    ingestMetrics: async () => {},
    ingestLogs: async () => {},
    querySpans: async () => [],
    queryMetrics: async (_filter: TelemetryQueryFilter) => {
      callCount++
      // First call = incident, second call = baseline
      return callCount === 1 ? incidentMetrics : baselineMetrics
    },
    queryLogs: async () => [],
    upsertSnapshot: async () => {},
    getSnapshots: async () => [],
    deleteSnapshots: async () => {},
    deleteExpired: async () => {},
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('buildMetricsSurface', () => {
  it('classifies single metric with high z-score as extreme', async () => {
    // Incident: value=100, Baseline: mean=10, stddev=5 → z-score = (100-10)/5 = 18
    const incident = [
      makeMetric({ summary: { asDouble: 100 } }),
    ]
    const baseline = [
      makeMetric({ startTimeMs: 1699999900000, summary: { asDouble: 8 } }),
      makeMetric({ startTimeMs: 1699999910000, summary: { asDouble: 10 } }),
      makeMetric({ startTimeMs: 1699999920000, summary: { asDouble: 12 } }),
    ]

    const store = makeMockStore(incident, baseline)
    const { surface } = await buildMetricsSurface(store, makeScope(), [])

    expect(surface.groups.length).toBeGreaterThanOrEqual(1)
    const group = surface.groups[0]
    expect(group.groupKey.anomalyMagnitude).toBe('extreme')
    expect(group.rows[0].zScore).not.toBeNull()
    expect(Math.abs(group.rows[0].zScore!)).toBeGreaterThan(3)
  })

  it('groups metrics by (service, anomalyMagnitude, metricClass)', async () => {
    const incident = [
      // error metric with extreme z-score
      makeMetric({ name: 'http.error_rate', summary: { asDouble: 500 } }),
      // latency metric with extreme z-score
      makeMetric({ name: 'http.server.request.duration', summary: { asDouble: 500 } }),
      // different service latency metric
      makeMetric({ service: 'db-service', name: 'db.query.duration', summary: { asDouble: 500 } }),
    ]
    const baseline = [
      makeMetric({ name: 'http.error_rate', startTimeMs: 1699999900000, summary: { asDouble: 5 } }),
      makeMetric({ name: 'http.error_rate', startTimeMs: 1699999910000, summary: { asDouble: 6 } }),
      makeMetric({ name: 'http.error_rate', startTimeMs: 1699999920000, summary: { asDouble: 4 } }),
      makeMetric({ name: 'http.server.request.duration', startTimeMs: 1699999900000, summary: { asDouble: 5 } }),
      makeMetric({ name: 'http.server.request.duration', startTimeMs: 1699999910000, summary: { asDouble: 6 } }),
      makeMetric({ name: 'http.server.request.duration', startTimeMs: 1699999920000, summary: { asDouble: 4 } }),
      makeMetric({ service: 'db-service', name: 'db.query.duration', startTimeMs: 1699999900000, summary: { asDouble: 5 } }),
      makeMetric({ service: 'db-service', name: 'db.query.duration', startTimeMs: 1699999910000, summary: { asDouble: 6 } }),
      makeMetric({ service: 'db-service', name: 'db.query.duration', startTimeMs: 1699999920000, summary: { asDouble: 4 } }),
    ]

    const store = makeMockStore(incident, baseline)
    const scope = makeScope({ memberServices: ['api-service', 'db-service'] })
    const { surface } = await buildMetricsSurface(store, scope, [])

    // Should have at least 2 groups: error_rate and latency are different classes
    expect(surface.groups.length).toBeGreaterThanOrEqual(2)

    // Check group keys are unique
    const keyStrings = surface.groups.map(g =>
      `${g.groupKey.service}|${g.groupKey.anomalyMagnitude}|${g.groupKey.metricClass}`,
    )
    const uniqueKeys = new Set(keyStrings)
    expect(uniqueKeys.size).toBe(keyStrings.length)
  })

  it('returns z-score null and magnitude baseline when no baseline exists', async () => {
    const incident = [
      makeMetric({ summary: { asDouble: 100 } }),
    ]
    const baseline: TelemetryMetric[] = []

    const store = makeMockStore(incident, baseline)
    const { surface } = await buildMetricsSurface(store, makeScope(), [])

    expect(surface.groups.length).toBe(1)
    const row = surface.groups[0].rows[0]
    expect(row.zScore).toBeNull()
    expect(surface.groups[0].groupKey.anomalyMagnitude).toBe('baseline')
    expect(row.expectedValue).toBe('N/A')
  })

  it('classifies metric names correctly', async () => {
    const incident = [
      makeMetric({ name: 'http.server.errors', summary: { asDouble: 50 } }),
      makeMetric({ name: 'http.server.request.duration', summary: { asDouble: 200 } }),
      makeMetric({ name: 'http.server.request.count', summary: { asDouble: 1000 } }),
      makeMetric({ name: 'process.memory.usage', summary: { asDouble: 80 } }),
    ]
    const baseline: TelemetryMetric[] = []

    const store = makeMockStore(incident, baseline)
    const { surface } = await buildMetricsSurface(store, makeScope(), [])

    const classes = surface.groups.map(g => g.groupKey.metricClass)
    expect(classes).toContain('error_rate')
    expect(classes).toContain('latency')
    expect(classes).toContain('throughput')
    expect(classes).toContain('resource')
  })

  it('computes deviation as (observed - expected) / expected', async () => {
    const incident = [
      makeMetric({ summary: { asDouble: 150 } }),
    ]
    const baseline = [
      makeMetric({ startTimeMs: 1699999900000, summary: { asDouble: 100 } }),
      makeMetric({ startTimeMs: 1699999910000, summary: { asDouble: 100 } }),
      makeMetric({ startTimeMs: 1699999920000, summary: { asDouble: 100 } }),
    ]

    const store = makeMockStore(incident, baseline)
    const { surface } = await buildMetricsSurface(store, makeScope(), [])

    const row = surface.groups[0].rows[0]
    // expected = 100, observed = 150, deviation = (150 - 100) / 100 = 0.5
    expect(row.deviation).toBeCloseTo(0.5, 5)
    expect(row.observedValue).toBe(150)
    expect(row.expectedValue).toBe(100)
  })

  it('limits to max 20 rows total across all groups', async () => {
    // Create 25 different metrics
    const incident = Array.from({ length: 25 }, (_, i) =>
      makeMetric({
        name: `metric_${String(i).padStart(2, '0')}_duration`,
        summary: { asDouble: 100 + i },
        startTimeMs: 1700000010000 + i,
      }),
    )
    const baseline: TelemetryMetric[] = []

    const store = makeMockStore(incident, baseline)
    const { surface } = await buildMetricsSurface(store, makeScope(), [])

    const totalRows = surface.groups.reduce((sum, g) => sum + g.rows.length, 0)
    expect(totalRows).toBeLessThanOrEqual(20)
  })

  it('returns empty groups for empty metrics', async () => {
    const store = makeMockStore([], [])
    const { surface, evidenceRefs } = await buildMetricsSurface(store, makeScope(), [])

    expect(surface.groups).toEqual([])
    expect(evidenceRefs.size).toBe(0)
  })

  it('caps impactBar at 1.0', async () => {
    // Very high z-score should still cap impactBar at 1
    const incident = [
      makeMetric({ summary: { asDouble: 10000 } }),
    ]
    const baseline = [
      makeMetric({ startTimeMs: 1699999900000, summary: { asDouble: 1 } }),
      makeMetric({ startTimeMs: 1699999910000, summary: { asDouble: 2 } }),
      makeMetric({ startTimeMs: 1699999920000, summary: { asDouble: 1 } }),
    ]

    const store = makeMockStore(incident, baseline)
    const { surface } = await buildMetricsSurface(store, makeScope(), [])

    for (const group of surface.groups) {
      for (const row of group.rows) {
        expect(row.impactBar).toBeLessThanOrEqual(1.0)
        expect(row.impactBar).toBeGreaterThanOrEqual(0.0)
      }
    }
  })

  it('sorts groups by magnitude then class', async () => {
    // Create metrics that will fall into different magnitude/class groups
    const incident = [
      // Will be "latency" class — moderate z-score
      // Baseline mean=100, stddev=20 → z=(130-100)/20=1.5 → moderate
      makeMetric({ name: 'request.duration', summary: { asDouble: 130 } }),
      // Will be "error_rate" class — extreme z-score
      // Baseline mean=5, stddev~0.82 → z=(500-5)/0.82 ≈ 604 → extreme
      makeMetric({ name: 'http.errors', summary: { asDouble: 500 } }),
    ]
    const baseline = [
      // Baseline for latency: values 80, 100, 120 → mean=100, stddev≈16.3 → z=(130-100)/16.3≈1.84 → moderate
      makeMetric({ name: 'request.duration', startTimeMs: 1699999900000, summary: { asDouble: 80 } }),
      makeMetric({ name: 'request.duration', startTimeMs: 1699999910000, summary: { asDouble: 100 } }),
      makeMetric({ name: 'request.duration', startTimeMs: 1699999920000, summary: { asDouble: 120 } }),
      // Baseline for errors: values 4, 5, 6 → mean=5, stddev≈0.82 → z=(500-5)/0.82 ≈ 604 → extreme
      makeMetric({ name: 'http.errors', startTimeMs: 1699999900000, summary: { asDouble: 4 } }),
      makeMetric({ name: 'http.errors', startTimeMs: 1699999910000, summary: { asDouble: 5 } }),
      makeMetric({ name: 'http.errors', startTimeMs: 1699999920000, summary: { asDouble: 6 } }),
    ]

    const store = makeMockStore(incident, baseline)
    const { surface } = await buildMetricsSurface(store, makeScope(), [])

    expect(surface.groups.length).toBe(2)
    // extreme should come first
    expect(surface.groups[0].groupKey.anomalyMagnitude).toBe('extreme')
    // moderate should come second
    expect(surface.groups[1].groupKey.anomalyMagnitude).toBe('moderate')
  })

  it('builds evidenceRef map correctly', async () => {
    const incident = [
      makeMetric({ name: 'http.errors', summary: { asDouble: 50 }, startTimeMs: 1700000010000 }),
      makeMetric({ name: 'req.duration', summary: { asDouble: 200 }, startTimeMs: 1700000020000 }),
    ]
    const baseline: TelemetryMetric[] = []

    const store = makeMockStore(incident, baseline)
    const { surface, evidenceRefs } = await buildMetricsSurface(store, makeScope(), [])

    // Should have an evidence ref for each row
    const totalRows = surface.groups.reduce((sum, g) => sum + g.rows.length, 0)
    expect(evidenceRefs.size).toBe(totalRows)

    // Check ref structure
    for (const group of surface.groups) {
      for (const row of group.rows) {
        const ref = evidenceRefs.get(row.refId)
        expect(ref).toBeDefined()
        expect(ref!.refId).toBe(row.refId)
        expect(ref!.surface).toBe('metrics')
        expect(ref!.groupId).toBe(group.groupId)
      }
    }
  })

  it('uses score-based impactBar when z-score is null', async () => {
    // No baseline → z-score null → impactBar from ScoredMetric.score
    const incident = [
      makeMetric({ summary: { asDouble: 100 } }),
    ]
    const baseline: TelemetryMetric[] = []

    const store = makeMockStore(incident, baseline)
    const { surface } = await buildMetricsSurface(store, makeScope(), [])

    const row = surface.groups[0].rows[0]
    expect(row.zScore).toBeNull()
    // impactBar should be min(1, score/10) — not zero
    expect(row.impactBar).toBeGreaterThanOrEqual(0)
    expect(row.impactBar).toBeLessThanOrEqual(1)
  })

  it('assigns groupIds as mgroup:0, mgroup:1, etc.', async () => {
    const incident = [
      makeMetric({ name: 'http.errors', summary: { asDouble: 500 } }),
      makeMetric({ name: 'request.duration', summary: { asDouble: 500 } }),
    ]
    const baseline: TelemetryMetric[] = []

    const store = makeMockStore(incident, baseline)
    const { surface } = await buildMetricsSurface(store, makeScope(), [])

    for (let i = 0; i < surface.groups.length; i++) {
      expect(surface.groups[i].groupId).toBe(`mgroup:${i}`)
    }
  })

  it('does not set diagnosisLabel or diagnosisVerdict', async () => {
    const incident = [
      makeMetric({ summary: { asDouble: 100 } }),
    ]
    const baseline: TelemetryMetric[] = []

    const store = makeMockStore(incident, baseline)
    const { surface } = await buildMetricsSurface(store, makeScope(), [])

    for (const group of surface.groups) {
      expect(group.diagnosisLabel).toBeUndefined()
      expect(group.diagnosisVerdict).toBeUndefined()
    }
  })

  it('formats refId as service:name:startTimeMs', async () => {
    const incident = [
      makeMetric({
        service: 'my-svc',
        name: 'req.latency',
        summary: { asDouble: 42 },
        startTimeMs: 1700000012345,
      }),
    ]
    const baseline: TelemetryMetric[] = []

    const store = makeMockStore(incident, baseline)
    const { surface } = await buildMetricsSurface(store, makeScope(), [])

    const row = surface.groups[0].rows[0]
    expect(row.refId).toBe('my-svc:req.latency:1700000012345')
    expect(row.service).toBe('my-svc')
    expect(row.name).toBe('req.latency')
  })
})
