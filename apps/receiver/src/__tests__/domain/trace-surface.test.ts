import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildTraceSurface } from '../../domain/trace-surface.js'
import type { TelemetrySpan, TelemetryLog, TelemetryStoreDriver } from '../../telemetry/interface.js'
import type { Incident } from '../../storage/interface.js'
import type { IncidentPacket } from '@3amoncall/core'
import type { BaselineContext } from '@3amoncall/core/schemas/curated-evidence'

// ── Mock baseline-selector ─────────────────────────────────────────────

vi.mock('../../domain/baseline-selector.js', () => ({
  selectBaseline: vi.fn(),
}))

import { selectBaseline } from '../../domain/baseline-selector.js'
const mockSelectBaseline = vi.mocked(selectBaseline)

// ── Helpers ─────────────────────────────────────────────────────────────

let spanCounter = 0

function makeSpan(overrides: Partial<TelemetrySpan> = {}): TelemetrySpan {
  spanCounter++
  return {
    traceId: 'trace-1',
    spanId: `span-${spanCounter}`,
    serviceName: 'web',
    environment: 'production',
    spanName: 'GET /api/orders',
    httpRoute: '/api/orders',
    httpStatusCode: 200,
    spanStatusCode: 1,
    durationMs: 50,
    startTimeMs: 1700000000000,
    exceptionCount: 0,
    attributes: {},
    ingestedAt: Date.now(),
    ...overrides,
  }
}

function makeLog(overrides: Partial<TelemetryLog> = {}): TelemetryLog {
  return {
    service: 'web',
    environment: 'production',
    timestamp: '2024-01-01T00:00:01Z',
    startTimeMs: 1700000001000,
    severity: 'ERROR',
    severityNumber: 17,
    body: 'Stripe 429',
    bodyHash: 'hash-1',
    attributes: {},
    ingestedAt: Date.now(),
    ...overrides,
  }
}

function makeMockStore(spans: TelemetrySpan[], logs: TelemetryLog[] = []): TelemetryStoreDriver {
  return {
    querySpans: vi.fn().mockResolvedValue(spans),
    queryMetrics: vi.fn().mockResolvedValue([]),
    queryLogs: vi.fn().mockResolvedValue(logs),
    ingestSpans: vi.fn().mockResolvedValue(undefined),
    ingestMetrics: vi.fn().mockResolvedValue(undefined),
    ingestLogs: vi.fn().mockResolvedValue(undefined),
    upsertSnapshot: vi.fn().mockResolvedValue(undefined),
    getSnapshots: vi.fn().mockResolvedValue([]),
    deleteSnapshots: vi.fn().mockResolvedValue(undefined),
    deleteExpired: vi.fn().mockResolvedValue(undefined),
  }
}

function makeMinimalPacket(overrides: Partial<IncidentPacket> = {}): IncidentPacket {
  return {
    schemaVersion: 'incident-packet/v1alpha1',
    packetId: 'pkt-1',
    incidentId: 'inc-1',
    openedAt: '2024-01-01T00:00:00Z',
    window: {
      start: '2024-01-01T00:00:00Z',
      detect: '2024-01-01T00:01:00Z',
      end: '2024-01-01T00:05:00Z',
    },
    scope: {
      environment: 'production',
      primaryService: 'web',
      affectedServices: ['web'],
      affectedRoutes: ['/api/orders'],
      affectedDependencies: ['stripe'],
    },
    triggerSignals: [],
    evidence: {
      changedMetrics: [],
      representativeTraces: [],
      relevantLogs: [],
      platformEvents: [],
    },
    pointers: {
      traceRefs: [],
      logRefs: [],
      metricRefs: [],
      platformLogRefs: [],
    },
    ...overrides,
  }
}

function makeIncident(
  spans: TelemetrySpan[],
  overrides: Partial<Incident> = {},
): Incident {
  const spanMembership = spans.map((s) => `${s.traceId}:${s.spanId}`)
  return {
    incidentId: 'inc-1',
    status: 'open',
    openedAt: '2024-01-01T00:00:00Z',
    packet: makeMinimalPacket(),
    telemetryScope: {
      windowStartMs: 1700000000000,
      windowEndMs: 1700000300000,
      detectTimeMs: 1700000060000,
      environment: 'production',
      memberServices: ['web'],
      dependencyServices: ['stripe'],
    },
    spanMembership,
    anomalousSignals: [],
    platformEvents: [],
    ...overrides,
  }
}

const EMPTY_BASELINE_CONTEXT: BaselineContext = {
  windowStart: '2024-01-01T00:00:00Z',
  windowEnd: '2024-01-01T00:05:00Z',
  sampleCount: 0,
  confidence: 'unavailable',
  source: { kind: 'none' },
}

// ── Tests ───────────────────────────────────────────────────────────────

beforeEach(() => {
  spanCounter = 0
  vi.clearAllMocks()
  mockSelectBaseline.mockResolvedValue({
    context: EMPTY_BASELINE_CONTEXT,
    spans: [],
  })
})

describe('buildTraceSurface', () => {
  // ── Test 1: Single trace with root + child → correct offsetMs/widthPct ──

  it('computes correct offsetMs and widthPct for root + child spans', async () => {
    const rootSpan = makeSpan({
      traceId: 'trace-1',
      spanId: 'root',
      parentSpanId: undefined,
      spanName: 'GET /api/orders',
      durationMs: 100,
      startTimeMs: 1700000000000,
    })
    const childSpan = makeSpan({
      traceId: 'trace-1',
      spanId: 'child',
      parentSpanId: 'root',
      spanName: 'db.query',
      durationMs: 40,
      startTimeMs: 1700000000020,
    })

    const incident = makeIncident([rootSpan, childSpan])
    const store = makeMockStore([rootSpan, childSpan])

    const { surface } = await buildTraceSurface(incident, store)

    expect(surface.observed).toHaveLength(1)
    const trace = surface.observed[0]!
    expect(trace.traceId).toBe('trace-1')
    expect(trace.rootSpanName).toBe('GET /api/orders')
    expect(trace.durationMs).toBe(100)
    expect(trace.startTimeMs).toBe(1700000000000)
    expect(trace.groupId).toBe('trace:trace-1')

    const root = trace.spans.find((s) => s.spanId === 'root')!
    expect(root.offsetMs).toBe(0)
    expect(root.widthPct).toBe(100) // root duration / root duration * 100

    const child = trace.spans.find((s) => s.spanId === 'child')!
    expect(child.offsetMs).toBe(20) // 1700000000020 - 1700000000000
    expect(child.widthPct).toBe(40) // 40 / 100 * 100
    expect(child.refId).toBe('trace-1:child')
  })

  // ── Test 2: Error span → trace status "error" ──

  it('marks trace as "error" when any span has error status', async () => {
    const rootSpan = makeSpan({
      traceId: 'trace-err',
      spanId: 'root',
      parentSpanId: undefined,
      durationMs: 100,
      startTimeMs: 1700000000000,
    })
    const errorSpan = makeSpan({
      traceId: 'trace-err',
      spanId: 'err-child',
      parentSpanId: 'root',
      httpStatusCode: 500,
      spanStatusCode: 2,
      durationMs: 50,
      startTimeMs: 1700000000010,
    })

    const incident = makeIncident([rootSpan, errorSpan])
    const store = makeMockStore([rootSpan, errorSpan])

    const { surface } = await buildTraceSurface(incident, store)

    expect(surface.observed[0]!.status).toBe('error')
    const errChild = surface.observed[0]!.spans.find((s) => s.spanId === 'err-child')!
    expect(errChild.status).toBe('error')
  })

  // ── Test 3: Slow root → trace status "slow" ──

  it('marks trace as "slow" when root span exceeds threshold', async () => {
    const slowRoot = makeSpan({
      traceId: 'trace-slow',
      spanId: 'root',
      parentSpanId: undefined,
      durationMs: 6000, // > 5000ms threshold
      startTimeMs: 1700000000000,
    })

    const incident = makeIncident([slowRoot])
    const store = makeMockStore([slowRoot])

    const { surface } = await buildTraceSurface(incident, store)

    expect(surface.observed[0]!.status).toBe('slow')
    expect(surface.observed[0]!.spans[0]!.status).toBe('slow')
  })

  // ── Test 4: Normal trace → status "ok" ──

  it('marks normal traces as "ok"', async () => {
    const normalRoot = makeSpan({
      traceId: 'trace-ok',
      spanId: 'root',
      parentSpanId: undefined,
      httpStatusCode: 200,
      spanStatusCode: 1,
      durationMs: 50,
      startTimeMs: 1700000000000,
    })

    const incident = makeIncident([normalRoot])
    const store = makeMockStore([normalRoot])

    const { surface } = await buildTraceSurface(incident, store)

    expect(surface.observed[0]!.status).toBe('ok')
    expect(surface.observed[0]!.spans[0]!.status).toBe('ok')
  })

  // ── Test 5: smokingGunSpanId selects highest-scored span ──

  it('selects highest-scored span as smokingGunSpanId', async () => {
    const normalSpan = makeSpan({
      traceId: 'trace-1',
      spanId: 'normal',
      parentSpanId: undefined,
      httpStatusCode: 200,
      spanStatusCode: 1,
      durationMs: 50,
      startTimeMs: 1700000000000,
      exceptionCount: 0,
    })
    // Score: httpStatusCode=429 (+3+3) + spanStatusCode=2 (+2) + peerService (+1) = 9
    const highScoreSpan = makeSpan({
      traceId: 'trace-1',
      spanId: 'smoking-gun',
      parentSpanId: 'normal',
      httpStatusCode: 429,
      spanStatusCode: 2,
      durationMs: 50,
      startTimeMs: 1700000000010,
      exceptionCount: 0,
      peerService: 'stripe',
    })
    // Score: httpStatusCode=500 (+3) + spanStatusCode=2 (+2) = 5
    const midScoreSpan = makeSpan({
      traceId: 'trace-1',
      spanId: 'mid-score',
      parentSpanId: 'normal',
      httpStatusCode: 500,
      spanStatusCode: 2,
      durationMs: 50,
      startTimeMs: 1700000000020,
      exceptionCount: 0,
    })

    const incident = makeIncident([normalSpan, highScoreSpan, midScoreSpan])
    const store = makeMockStore([normalSpan, highScoreSpan, midScoreSpan])

    const { surface } = await buildTraceSurface(incident, store)

    expect(surface.smokingGunSpanId).toBe('trace-1:smoking-gun')
  })

  // ── Test 6: No anomalous spans → smokingGunSpanId undefined ──

  it('returns undefined smokingGunSpanId when no anomalous spans', async () => {
    const normalSpan = makeSpan({
      traceId: 'trace-1',
      spanId: 'normal',
      parentSpanId: undefined,
      httpStatusCode: 200,
      spanStatusCode: 1,
      durationMs: 50,
      startTimeMs: 1700000000000,
      exceptionCount: 0,
      peerService: undefined,
    })

    const incident = makeIncident([normalSpan])
    const store = makeMockStore([normalSpan])

    const { surface } = await buildTraceSurface(incident, store)

    expect(surface.smokingGunSpanId).toBeUndefined()
  })

  // ── Test 7: Baseline returned from baseline-selector ──

  it('returns baseline context from selectBaseline', async () => {
    const baselineContext: BaselineContext = {
      windowStart: '2024-01-01T00:00:00Z',
      windowEnd: '2024-01-01T00:05:00Z',
      sampleCount: 35,
      confidence: 'high',
      source: { kind: 'same_route', route: '/api/orders', service: 'web' },
    }
    const baselineSpan = makeSpan({
      traceId: 'baseline-trace',
      spanId: 'b-root',
      parentSpanId: undefined,
      durationMs: 45,
      startTimeMs: 1699999700000,
    })
    mockSelectBaseline.mockResolvedValue({
      context: baselineContext,
      spans: [baselineSpan],
    })

    const normalSpan = makeSpan({
      traceId: 'trace-1',
      spanId: 'root',
      parentSpanId: undefined,
      startTimeMs: 1700000000000,
    })
    const incident = makeIncident([normalSpan])
    const store = makeMockStore([normalSpan])

    const { surface } = await buildTraceSurface(incident, store)

    expect(surface.baseline).toEqual(baselineContext)
    expect(surface.expected).toHaveLength(1)
    expect(surface.expected[0]!.traceId).toBe('baseline-trace')
    expect(surface.expected[0]!.groupId).toBe('trace:baseline-trace')

    // Verify selectBaseline was called with correct args
    expect(mockSelectBaseline).toHaveBeenCalledWith(store, {
      incidentWindowStartMs: 1700000000000,
      incidentWindowEndMs: 1700000300000,
      primaryService: 'web',
      httpRoute: '/api/orders',
    })
  })

  // ── Test 8: Empty incident (no spans) → empty observed ──

  it('returns empty observed with baseline from selector when no spans', async () => {
    const incident = makeIncident([]) // no span membership
    const store = makeMockStore([]) // no spans in store either

    const { surface, evidenceRefs } = await buildTraceSurface(incident, store)

    expect(surface.observed).toEqual([])
    expect(surface.smokingGunSpanId).toBeUndefined()
    expect(surface.baseline).toEqual(EMPTY_BASELINE_CONTEXT)
    expect(evidenceRefs.size).toBe(0)
  })

  // ── Test 9: Max 10 observed traces (limit) ──

  it('limits observed traces to 10', async () => {
    // Create 15 traces, each with one root span
    const spans: TelemetrySpan[] = []
    for (let i = 0; i < 15; i++) {
      spans.push(
        makeSpan({
          traceId: `trace-${i}`,
          spanId: `root-${i}`,
          parentSpanId: undefined,
          durationMs: 50,
          startTimeMs: 1700000000000 + i * 1000,
        }),
      )
    }

    const incident = makeIncident(spans)
    const store = makeMockStore(spans)

    const { surface } = await buildTraceSurface(incident, store)

    expect(surface.observed).toHaveLength(10)
  })

  // ── Test 10: EvidenceRef map contains all spans ──

  it('builds EvidenceRef entries for all observed and expected spans', async () => {
    const rootSpan = makeSpan({
      traceId: 'trace-1',
      spanId: 'root',
      parentSpanId: undefined,
      httpStatusCode: 500,
      spanStatusCode: 2,
      durationMs: 100,
      startTimeMs: 1700000000000,
      exceptionCount: 1,
    })
    const childSpan = makeSpan({
      traceId: 'trace-1',
      spanId: 'child',
      parentSpanId: 'root',
      durationMs: 40,
      startTimeMs: 1700000000020,
    })

    const baselineSpan = makeSpan({
      traceId: 'baseline-trace',
      spanId: 'b-root',
      parentSpanId: undefined,
      durationMs: 45,
      startTimeMs: 1699999700000,
    })
    mockSelectBaseline.mockResolvedValue({
      context: EMPTY_BASELINE_CONTEXT,
      spans: [baselineSpan],
    })

    const incident = makeIncident([rootSpan, childSpan])
    const store = makeMockStore([rootSpan, childSpan])

    const { evidenceRefs, surface } = await buildTraceSurface(incident, store)

    // 2 observed spans + 1 baseline span = 3 refs
    expect(evidenceRefs.size).toBe(3)

    // Observed refs
    const rootRef = evidenceRefs.get('trace-1:root')!
    expect(rootRef.surface).toBe('traces')
    expect(rootRef.groupId).toBe('trace:trace-1')
    // root has score > 0 (httpStatusCode 500 + spanStatusCode 2 + exceptionCount), so it's the smoking gun
    expect(rootRef.isSmokingGun).toBe(true)
    expect(surface.smokingGunSpanId).toBe('trace-1:root')

    const childRef = evidenceRefs.get('trace-1:child')!
    expect(childRef.surface).toBe('traces')
    expect(childRef.groupId).toBe('trace:trace-1')
    expect(childRef.isSmokingGun).toBe(false)

    // Baseline ref
    const baseRef = evidenceRefs.get('baseline-trace:b-root')!
    expect(baseRef.surface).toBe('traces')
    expect(baseRef.groupId).toBe('trace:baseline-trace')
    expect(baseRef.isSmokingGun).toBe(false)
  })

  it('correlates logs to spans deterministically within a ±2s window', async () => {
    const rootSpan = makeSpan({
      traceId: 'trace-1',
      spanId: 'root',
      parentSpanId: undefined,
      startTimeMs: 1700000000000,
      durationMs: 500,
    })
    const childSpan = makeSpan({
      traceId: 'trace-1',
      spanId: 'child',
      parentSpanId: 'root',
      startTimeMs: 1700000004000,
      durationMs: 300,
    })
    const logs = [
      makeLog({
        timestamp: '2024-01-01T00:00:01Z',
        bodyHash: 'hash-root',
        startTimeMs: 1700000001000,
        traceId: 'trace-1',
        spanId: 'root',
      }),
      makeLog({
        timestamp: '2024-01-01T00:00:02Z',
        bodyHash: 'hash-trace',
        startTimeMs: 1700000004500,
        traceId: 'trace-1',
      }),
      makeLog({
        timestamp: '2024-01-01T00:00:10Z',
        bodyHash: 'hash-outside',
        startTimeMs: 1700000010000,
        traceId: 'trace-1',
      }),
    ]

    const incident = makeIncident([rootSpan, childSpan])
    const store = makeMockStore([rootSpan, childSpan], logs)

    const { surface } = await buildTraceSurface(incident, store)

    const root = surface.observed[0]!.spans.find((span) => span.spanId === 'root')!
    const child = surface.observed[0]!.spans.find((span) => span.spanId === 'child')!

    expect(root.correlatedLogRefIds).toEqual(['web:2024-01-01T00:00:01Z:hash-root'])
    expect(child.correlatedLogRefIds).toEqual(['web:2024-01-01T00:00:02Z:hash-trace'])
  })

  // ── Sort order: error traces first, then slow, then ok ──

  it('sorts observed traces by severity: error > slow > ok', async () => {
    const okSpan = makeSpan({
      traceId: 'trace-ok',
      spanId: 'ok-root',
      parentSpanId: undefined,
      httpStatusCode: 200,
      spanStatusCode: 1,
      durationMs: 50,
      startTimeMs: 1700000000000,
    })
    const slowSpan = makeSpan({
      traceId: 'trace-slow',
      spanId: 'slow-root',
      parentSpanId: undefined,
      httpStatusCode: 200,
      spanStatusCode: 1,
      durationMs: 6000,
      startTimeMs: 1700000001000,
    })
    const errorSpan = makeSpan({
      traceId: 'trace-error',
      spanId: 'error-root',
      parentSpanId: undefined,
      httpStatusCode: 500,
      spanStatusCode: 2,
      durationMs: 50,
      startTimeMs: 1700000002000,
    })

    // Insert in ok, slow, error order to verify sort works
    const incident = makeIncident([okSpan, slowSpan, errorSpan])
    const store = makeMockStore([okSpan, slowSpan, errorSpan])

    const { surface } = await buildTraceSurface(incident, store)

    expect(surface.observed).toHaveLength(3)
    expect(surface.observed[0]!.status).toBe('error')
    expect(surface.observed[1]!.status).toBe('slow')
    expect(surface.observed[2]!.status).toBe('ok')
  })

  // ── Only incident-bound spans are included ──

  it('filters out spans not in spanMembership', async () => {
    const memberSpan = makeSpan({
      traceId: 'trace-1',
      spanId: 'member',
      parentSpanId: undefined,
      startTimeMs: 1700000000000,
    })
    const nonMemberSpan = makeSpan({
      traceId: 'trace-2',
      spanId: 'non-member',
      parentSpanId: undefined,
      startTimeMs: 1700000001000,
    })

    // Only include memberSpan in spanMembership
    const incident = makeIncident([memberSpan])
    // Store returns both spans
    const store = makeMockStore([memberSpan, nonMemberSpan])

    const { surface } = await buildTraceSurface(incident, store)

    expect(surface.observed).toHaveLength(1)
    expect(surface.observed[0]!.traceId).toBe('trace-1')
  })

  // ── httpRoute falls back to undefined when affectedRoutes is empty ──

  it('passes undefined httpRoute to selectBaseline when affectedRoutes is empty', async () => {
    const span = makeSpan({
      traceId: 'trace-1',
      spanId: 'root',
      parentSpanId: undefined,
    })
    const incident = makeIncident([span], {
      packet: makeMinimalPacket({
        scope: {
          environment: 'production',
          primaryService: 'web',
          affectedServices: ['web'],
          affectedRoutes: [],
          affectedDependencies: [],
        },
      }),
    })
    const store = makeMockStore([span])

    await buildTraceSurface(incident, store)

    expect(mockSelectBaseline).toHaveBeenCalledWith(store, {
      incidentWindowStartMs: 1700000000000,
      incidentWindowEndMs: 1700000300000,
      primaryService: 'web',
      httpRoute: undefined,
    })
  })
})
