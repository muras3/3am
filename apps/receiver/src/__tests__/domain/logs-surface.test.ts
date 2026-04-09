import { describe, it, expect, vi } from 'vitest'
import { buildLogsSurface } from '../../domain/logs-surface.js'
import type { TelemetryLog, TelemetryStoreDriver } from '../../telemetry/interface.js'
import type { TelemetryScope, AnomalousSignal } from '../../storage/interface.js'

// ── Helpers ─────────────────────────────────────────────────────────────

let logCounter = 0

function makeLog(overrides: Partial<TelemetryLog> = {}): TelemetryLog {
  logCounter++
  return {
    service: 'web',
    environment: 'production',
    timestamp: '2025-03-07T16:05:00.000Z',
    startTimeMs: 1741392300000,
    severity: 'ERROR',
    severityNumber: 17,
    body: 'something went wrong',
    bodyHash: `hash-${logCounter}`,
    attributes: {},
    ingestedAt: Date.now(),
    ...overrides,
  }
}

function makeScope(overrides: Partial<TelemetryScope> = {}): TelemetryScope {
  return {
    windowStartMs: 1741392000000,
    windowEndMs: 1741392600000,
    detectTimeMs: 1741392300000,
    environment: 'production',
    memberServices: ['web'],
    dependencyServices: [],
    ...overrides,
  }
}

function makeMockStore(logs: TelemetryLog[] = []): TelemetryStoreDriver {
  return {
    querySpans: vi.fn().mockResolvedValue([]),
    queryMetrics: vi.fn().mockResolvedValue([]),
    queryLogs: vi.fn().mockResolvedValue(logs),
    ingestSpans: vi.fn().mockResolvedValue(undefined),
    ingestMetrics: vi.fn().mockResolvedValue(undefined),
    ingestLogs: vi.fn().mockResolvedValue(undefined),
    upsertSnapshot: vi.fn().mockResolvedValue(undefined),
    getSnapshots: vi.fn().mockResolvedValue([]),
    deleteSnapshots: vi.fn().mockResolvedValue(undefined),
    deleteExpired: vi.fn().mockResolvedValue(undefined),
    deleteExpiredSnapshots: vi.fn().mockResolvedValue(undefined),
  }
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('buildLogsSurface', () => {
  it('clusters logs by service and severity', async () => {
    const logs = [
      makeLog({ service: 'web', severity: 'ERROR', body: 'error msg A' }),
      makeLog({ service: 'web', severity: 'ERROR', body: 'error msg B' }),
      makeLog({ service: 'api', severity: 'WARN', body: 'warn msg' }),
    ]
    const store = makeMockStore(logs)
    const scope = makeScope({ memberServices: ['web', 'api'] })

    const result = await buildLogsSurface(store, scope, [], [])

    // web/ERROR entries should be in one cluster, api/WARN in another
    expect(result.surface.clusters.length).toBeGreaterThanOrEqual(2)

    const webCluster = result.surface.clusters.find(
      (c) => c.clusterKey.primaryService === 'web' && c.clusterKey.severityDominant === 'ERROR',
    )
    expect(webCluster).toBeDefined()
    expect(webCluster!.entries.length).toBe(2)

    const apiCluster = result.surface.clusters.find(
      (c) => c.clusterKey.primaryService === 'api' && c.clusterKey.severityDominant === 'WARN',
    )
    expect(apiCluster).toBeDefined()
    expect(apiCluster!.entries.length).toBe(1)
  })

  it('isSignal: ERROR/FATAL → true, INFO → false', async () => {
    const logs = [
      makeLog({ severity: 'ERROR', body: 'error log' }),
      makeLog({ severity: 'FATAL', body: 'fatal log' }),
      makeLog({ severity: 'INFO', body: 'info log' }),
    ]
    const store = makeMockStore(logs)
    const scope = makeScope()

    const result = await buildLogsSurface(store, scope, [], [])

    const allEntries = result.surface.clusters.flatMap((c) => c.entries)
    const errorEntry = allEntries.find((e) => e.severity === 'ERROR')
    const fatalEntry = allEntries.find((e) => e.severity === 'FATAL')
    const infoEntry = allEntries.find((e) => e.severity === 'INFO')

    expect(errorEntry!.isSignal).toBe(true)
    expect(fatalEntry!.isSignal).toBe(true)
    expect(infoEntry!.isSignal).toBe(false)
  })

  it('detects keyword hits in body', async () => {
    const logs = [
      makeLog({ severity: 'WARN', body: 'Connection timeout after 30s' }),
    ]
    const store = makeMockStore(logs)
    const scope = makeScope()

    const result = await buildLogsSurface(store, scope, [], [])

    const cluster = result.surface.clusters.find((c) =>
      c.clusterKey.keywordHits.includes('timeout'),
    )
    expect(cluster).toBeDefined()
    // timeout keyword hit → isSignal should be true even for WARN
    expect(cluster!.entries[0]!.isSignal).toBe(true)
  })

  it('hasTraceCorrelation when traceId matches spanMembership', async () => {
    const logs = [
      makeLog({
        severity: 'ERROR',
        body: 'error with trace',
        traceId: 'trace-abc',
        spanId: 'span-xyz',
      }),
    ]
    const store = makeMockStore(logs)
    const scope = makeScope()

    // spanMembership format: "traceId:spanId"
    const spanMembership = ['trace-abc:span-001']

    const result = await buildLogsSurface(store, scope, [], spanMembership)

    const correlatedCluster = result.surface.clusters.find(
      (c) => c.clusterKey.hasTraceCorrelation === true,
    )
    expect(correlatedCluster).toBeDefined()
  })

  it('signalCount and noiseCount per cluster', async () => {
    const logs = [
      makeLog({ service: 'web', severity: 'ERROR', body: 'error 1' }),
      makeLog({ service: 'web', severity: 'ERROR', body: 'error 2' }),
      makeLog({ service: 'web', severity: 'INFO', body: 'info log' }),
    ]
    const store = makeMockStore(logs)
    const scope = makeScope()

    const result = await buildLogsSurface(store, scope, [], [])

    // ERROR cluster should have signalCount = 2
    const errorCluster = result.surface.clusters.find(
      (c) => c.clusterKey.severityDominant === 'ERROR',
    )
    expect(errorCluster).toBeDefined()
    expect(errorCluster!.signalCount).toBe(2)
    expect(errorCluster!.noiseCount).toBe(0)

    // INFO cluster should have noiseCount = 1
    const infoCluster = result.surface.clusters.find(
      (c) => c.clusterKey.severityDominant === 'INFO',
    )
    expect(infoCluster).toBeDefined()
    expect(infoCluster!.signalCount).toBe(0)
    expect(infoCluster!.noiseCount).toBe(1)
  })

  it('caps entries per cluster at 50', async () => {
    const logs: TelemetryLog[] = []
    for (let i = 0; i < 60; i++) {
      logs.push(makeLog({ service: 'web', severity: 'ERROR', body: `error ${i}` }))
    }
    const store = makeMockStore(logs)
    const scope = makeScope()

    const result = await buildLogsSurface(store, scope, [], [])

    for (const cluster of result.surface.clusters) {
      expect(cluster.entries.length).toBeLessThanOrEqual(50)
    }
  })

  it('returns empty clusters for empty logs', async () => {
    const store = makeMockStore([])
    const scope = makeScope()

    const result = await buildLogsSurface(store, scope, [], [])

    expect(result.surface.clusters).toHaveLength(0)
  })

  it('builds EvidenceRef map correctly for log entries', async () => {
    const logs = [
      makeLog({ service: 'web', severity: 'ERROR', body: 'error log' }),
    ]
    const store = makeMockStore(logs)
    const scope = makeScope()

    const result = await buildLogsSurface(store, scope, [], [])

    const cluster = result.surface.clusters[0]!
    const entry = cluster.entries[0]!

    const ref = result.evidenceRefs.get(entry.refId)
    expect(ref).toBeDefined()
    expect(ref!.surface).toBe('logs')
    expect(ref!.groupId).toBe(cluster.clusterId)
    expect(ref!.refId).toBe(entry.refId)
  })

  it('refId format is "service:timestamp:bodyHash"', async () => {
    const logs = [
      makeLog({
        service: 'web',
        timestamp: '2025-03-07T16:05:00.000Z',
        bodyHash: 'abcdef1234567890',
        severity: 'ERROR',
        body: 'test',
      }),
    ]
    const store = makeMockStore(logs)
    const scope = makeScope()

    const result = await buildLogsSurface(store, scope, [], [])

    const entry = result.surface.clusters[0]!.entries[0]!
    expect(entry.refId).toBe('web:2025-03-07T16:05:00.000Z:abcdef1234567890')
  })

  it('clusters are sorted by signalCount descending', async () => {
    const logs = [
      // Cluster with 1 signal
      makeLog({ service: 'api', severity: 'ERROR', body: 'single error' }),
      // Cluster with 3 signals
      makeLog({ service: 'web', severity: 'ERROR', body: 'error 1' }),
      makeLog({ service: 'web', severity: 'ERROR', body: 'error 2' }),
      makeLog({ service: 'web', severity: 'ERROR', body: 'error 3' }),
    ]
    const store = makeMockStore(logs)
    const scope = makeScope({ memberServices: ['web', 'api'] })

    const result = await buildLogsSurface(store, scope, [], [])

    // First cluster should have the highest signalCount
    expect(result.surface.clusters[0]!.signalCount).toBeGreaterThanOrEqual(
      result.surface.clusters[result.surface.clusters.length - 1]!.signalCount,
    )
  })

  it('clusterId format is "lcluster:{index}"', async () => {
    const logs = [
      makeLog({ service: 'web', severity: 'ERROR', body: 'err' }),
      makeLog({ service: 'api', severity: 'WARN', body: 'warn' }),
    ]
    const store = makeMockStore(logs)
    const scope = makeScope({ memberServices: ['web', 'api'] })

    const result = await buildLogsSurface(store, scope, [], [])

    for (const cluster of result.surface.clusters) {
      expect(cluster.clusterId).toMatch(/^lcluster:\d+$/)
    }
  })

  it('diagnosisLabel and diagnosisVerdict are undefined', async () => {
    const logs = [
      makeLog({ severity: 'ERROR', body: 'error' }),
    ]
    const store = makeMockStore(logs)
    const scope = makeScope()

    const result = await buildLogsSurface(store, scope, [], [])

    for (const cluster of result.surface.clusters) {
      expect(cluster.diagnosisLabel).toBeUndefined()
      expect(cluster.diagnosisVerdict).toBeUndefined()
    }
  })

  it('includes absence evidence from absence detector', async () => {
    // No signal logs + anomalous signals present → absences should be detected
    const store = makeMockStore([])
    const scope = makeScope()
    const signals: AnomalousSignal[] = [
      {
        signal: 'http_429',
        firstSeenAt: '2025-03-07T16:05:00.000Z',
        entity: 'web',
        spanId: 'span-1',
      },
    ]

    const result = await buildLogsSurface(store, scope, signals, [])

    expect(result.surface.absenceEvidence.length).toBeGreaterThan(0)
    // Should include at least no-retry and no-rate-limit
    const patternIds = result.surface.absenceEvidence.map((e) => e.patternId)
    expect(patternIds).toContain('no-retry')
    expect(patternIds).toContain('no-rate-limit')
  })

  it('absence evidenceRefs are included in the returned map', async () => {
    const store = makeMockStore([])
    const scope = makeScope()
    const signals: AnomalousSignal[] = [
      {
        signal: 'http_429',
        firstSeenAt: '2025-03-07T16:05:00.000Z',
        entity: 'web',
        spanId: 'span-1',
      },
    ]

    const result = await buildLogsSurface(store, scope, signals, [])

    for (const absence of result.surface.absenceEvidence) {
      const ref = result.evidenceRefs.get(absence.patternId)
      expect(ref).toBeDefined()
      expect(ref!.surface).toBe('absences')
    }
  })

  it('hasTraceCorrelation false when log traceId does NOT match spanMembership', async () => {
    const logs = [
      makeLog({
        severity: 'ERROR',
        body: 'error with unrelated trace',
        traceId: 'trace-unrelated',
        spanId: 'span-xyz',
      }),
    ]
    const store = makeMockStore(logs)
    const scope = makeScope()
    const spanMembership = ['trace-abc:span-001']

    const result = await buildLogsSurface(store, scope, [], spanMembership)

    const cluster = result.surface.clusters[0]!
    expect(cluster.clusterKey.hasTraceCorrelation).toBe(false)
  })

  // ── #326 regression: empty/trivial body logs still produce clusters ──────

  it('#326: ERROR log with empty body still produces a non-empty cluster', async () => {
    // Simulates logs ingested before #316 fix: body stored as ''
    const logs = [
      makeLog({ service: 'web', severity: 'ERROR', body: '', attributes: {} }),
      makeLog({ service: 'web', severity: 'ERROR', body: '', attributes: {}, bodyHash: 'hash-2' }),
    ]
    const store = makeMockStore(logs)
    const scope = makeScope()

    const result = await buildLogsSurface(store, scope, [], [])

    expect(result.surface.clusters.length).toBeGreaterThan(0)
    const cluster = result.surface.clusters[0]!
    expect(cluster.entries.length).toBe(2)
    expect(cluster.signalCount).toBe(2)
  })

  it('#326: log with body "\\"\\"" (JSON-encoded empty string from CF body:null) is synthesised from attributes', async () => {
    // CF Workers sends body:null → JSON.stringify('') = '""' is stored as body
    // attributes have OTLP AnyValue-wrapped values (raw wire format)
    const logs = [
      makeLog({
        service: 'web',
        severity: 'ERROR',
        body: '""',
        attributes: {
          event: { stringValue: 'payment_failed' },
          'level': { stringValue: 'error' },
        },
      }),
    ]
    const store = makeMockStore(logs)
    const scope = makeScope()

    const result = await buildLogsSurface(store, scope, [], [])

    expect(result.surface.clusters.length).toBe(1)
    const entry = result.surface.clusters[0]!.entries[0]!
    // Body should be synthesised from attributes, not left as '""'
    expect(entry.body).not.toBe('""')
    expect(entry.body).toContain('payment_failed')
  })

  it('#326: WARN log with trivial body and keyword in attributes surfaces as signal', async () => {
    // WARN log with empty body + 'timeout' in attributes → isSignal should be true
    const logs = [
      makeLog({
        service: 'web',
        severity: 'WARN',
        body: '""',
        attributes: {
          error_message: { stringValue: 'connection timeout exceeded' },
        },
      }),
    ]
    const store = makeMockStore(logs)
    const scope = makeScope()

    const result = await buildLogsSurface(store, scope, [], [])

    expect(result.surface.clusters.length).toBe(1)
    const entry = result.surface.clusters[0]!.entries[0]!
    // After body synthesis, 'timeout' keyword hit → isSignal = true
    expect(entry.isSignal).toBe(true)
  })
})
