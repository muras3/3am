import { describe, it, expect, vi } from 'vitest'
import {
  selectBaseline,
  computeBaselineWindow,
  computeConfidence,
  deriveOperationIdentity,
  deriveDominantOperation,
  type BaselineQuery,
} from '../../domain/baseline-selector.js'
import type { TelemetrySpan, TelemetryStoreDriver } from '../../telemetry/interface.js'

// ── Helpers ─────────────────────────────────────────────────────────────

function makeSpan(overrides: Partial<TelemetrySpan> = {}): TelemetrySpan {
  return {
    traceId: 'trace-1',
    spanId: `span-${Math.random().toString(36).slice(2, 8)}`,
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

function makeMockStore(spans: TelemetrySpan[]): TelemetryStoreDriver {
  return {
    querySpans: vi.fn().mockResolvedValue(spans),
    queryMetrics: vi.fn().mockResolvedValue([]),
    queryLogs: vi.fn().mockResolvedValue([]),
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

const BASE_QUERY: BaselineQuery = {
  incidentWindowStartMs: 1700000300000, // +300s from epoch reference
  incidentWindowEndMs: 1700000600000,   // +600s (5 min incident)
  primaryService: 'web',
  operation: {
    service: 'web',
    family: { kind: 'route', value: '/api/orders' },
    method: 'POST',
  },
}

// ── deriveOperationIdentity ────────────────────────────────────────────

describe('deriveOperationIdentity', () => {
  it('uses httpRoute when present', () => {
    const span = makeSpan({ httpRoute: '/api/orders', httpMethod: 'POST' })
    const id = deriveOperationIdentity(span)
    expect(id.family).toEqual({ kind: 'route', value: '/api/orders' })
    expect(id.method).toBe('POST')
  })

  it('falls back to spanName when httpRoute is absent', () => {
    const span = makeSpan({ httpRoute: undefined, spanName: 'd1_run', httpMethod: 'POST' })
    const id = deriveOperationIdentity(span)
    expect(id.family).toEqual({ kind: 'span_name', value: 'd1_run' })
  })
})

// ── deriveDominantOperation ────────────────────────────────────────────

describe('deriveDominantOperation', () => {
  it('returns the most common operation', () => {
    const spans = [
      makeSpan({ httpRoute: undefined, spanName: 'd1_run', httpMethod: 'POST' }),
      makeSpan({ httpRoute: undefined, spanName: 'd1_run', httpMethod: 'POST' }),
      makeSpan({ httpRoute: '/api/orders', spanName: 'GET /api/orders', httpMethod: 'GET' }),
    ]
    const dominant = deriveDominantOperation(spans)
    expect(dominant?.family).toEqual({ kind: 'span_name', value: 'd1_run' })
  })

  it('returns undefined for empty spans', () => {
    expect(deriveDominantOperation([])).toBeUndefined()
  })
})

// ── computeBaselineWindow ───────────────────────────────────────────────

describe('computeBaselineWindow', () => {
  it('uses 4x incident duration when > 5 minutes', () => {
    // 10 min incident → 40 min lookback
    const result = computeBaselineWindow(1700000000000, 1700000600000)
    expect(result.endMs).toBe(1700000000000) // windowEnd = incident start
    expect(result.startMs).toBe(1700000000000 - 600_000 * 4)
  })

  it('enforces 5-minute minimum lookback', () => {
    // 30 sec incident → 4x = 120s < 300s → use 300s
    const start = 1700000000000
    const end = start + 30_000
    const result = computeBaselineWindow(start, end)
    expect(result.endMs).toBe(start)
    expect(result.startMs).toBe(start - 300_000)
  })

  it('uses 4x when exactly equal to 5 minutes', () => {
    // 75s incident → 4x = 300s = 5 min (equal), Math.max picks either
    const start = 1700000000000
    const end = start + 75_000
    const result = computeBaselineWindow(start, end)
    expect(result.endMs).toBe(start)
    // 75_000 * 4 = 300_000 = MIN_BASELINE_WINDOW_MS, both paths yield same result
    expect(result.startMs).toBe(start - 300_000)
  })
})

// ── computeConfidence ───────────────────────────────────────────────────

describe('computeConfidence', () => {
  it('returns "unavailable" for 0 samples', () => {
    expect(computeConfidence(0)).toBe('unavailable')
  })

  it('returns "low" for 1-9 samples', () => {
    expect(computeConfidence(1)).toBe('low')
    expect(computeConfidence(5)).toBe('low')
    expect(computeConfidence(9)).toBe('low')
  })

  it('returns "medium" for 10-29 samples', () => {
    expect(computeConfidence(10)).toBe('medium')
    expect(computeConfidence(15)).toBe('medium')
    expect(computeConfidence(29)).toBe('medium')
  })

  it('returns "high" for 30+ samples', () => {
    expect(computeConfidence(30)).toBe('high')
    expect(computeConfidence(100)).toBe('high')
  })
})

// ── selectBaseline ──────────────────────────────────────────────────────

describe('selectBaseline', () => {
  it('returns exact_operation when enough matching spans', async () => {
    // 35 normal spans on the same route + method
    const spans = Array.from({ length: 35 }, (_, i) =>
      makeSpan({
        traceId: `trace-${i}`,
        httpRoute: '/api/orders',
        httpMethod: 'POST',
        durationMs: 40 + i,
      }),
    )
    const store = makeMockStore(spans)
    const result = await selectBaseline(store, BASE_QUERY)

    expect(result.context.source).toEqual({
      kind: 'exact_operation',
      operation: '/api/orders',
      service: 'web',
    })
    expect(result.context.confidence).toBe('high')
    expect(result.context.sampleCount).toBe(35)
    const traceIds = new Set(result.spans.map((s) => s.traceId))
    expect(traceIds.size).toBeLessThanOrEqual(3)
    expect(result.spans.length).toBeGreaterThan(0)
  })

  it('falls back to same_operation_family when exact has < 5 spans but family has >= 3', async () => {
    // 3 POST + 5 GET on the same route
    const postSpans = Array.from({ length: 3 }, (_, i) =>
      makeSpan({
        traceId: `post-${i}`,
        httpRoute: '/api/orders',
        httpMethod: 'POST',
        durationMs: 50,
      }),
    )
    const getSpans = Array.from({ length: 5 }, (_, i) =>
      makeSpan({
        traceId: `get-${i}`,
        httpRoute: '/api/orders',
        httpMethod: 'GET',
        durationMs: 30,
      }),
    )
    const store = makeMockStore([...postSpans, ...getSpans])
    const result = await selectBaseline(store, BASE_QUERY)

    expect(result.context.source).toEqual({
      kind: 'same_operation_family',
      operation: '/api/orders',
      service: 'web',
    })
  })

  it('returns none when operation family has < 3 normal spans (no cross-operation fallback)', async () => {
    // 2 spans on the target route, 20 on a different route
    const targetSpans = Array.from({ length: 2 }, (_, i) =>
      makeSpan({
        traceId: `target-${i}`,
        httpRoute: '/api/orders',
        httpMethod: 'POST',
        durationMs: 50,
      }),
    )
    const otherSpans = Array.from({ length: 20 }, (_, i) =>
      makeSpan({
        traceId: `other-${i}`,
        httpRoute: '/api/products',
        httpMethod: 'GET',
        durationMs: 30,
      }),
    )
    const store = makeMockStore([...targetSpans, ...otherSpans])
    const result = await selectBaseline(store, BASE_QUERY)

    // Must NOT fall back to /api/products — return none instead
    expect(result.context.source).toEqual({ kind: 'none' })
    expect(result.spans).toEqual([])
  })

  it('matches by spanName for platform-internal spans (e.g. d1_run)', async () => {
    const query: BaselineQuery = {
      ...BASE_QUERY,
      operation: {
        service: 'web',
        family: { kind: 'span_name', value: 'd1_run' },
        method: 'POST',
      },
    }
    const spans = Array.from({ length: 10 }, (_, i) =>
      makeSpan({
        traceId: `trace-${i}`,
        httpRoute: undefined,
        spanName: 'd1_run',
        httpMethod: 'POST',
        durationMs: 40 + i,
      }),
    )
    const store = makeMockStore(spans)
    const result = await selectBaseline(store, query)

    expect(result.context.source).toEqual({
      kind: 'exact_operation',
      operation: 'd1_run',
      service: 'web',
    })
    expect(result.spans.length).toBeGreaterThan(0)
  })

  it('returns none with empty spans when store has no data', async () => {
    const store = makeMockStore([])
    const result = await selectBaseline(store, BASE_QUERY)

    expect(result.context.source).toEqual({ kind: 'none' })
    expect(result.context.confidence).toBe('unavailable')
    expect(result.context.sampleCount).toBe(0)
    expect(result.spans).toEqual([])
    expect(result.context.windowStart).toBeDefined()
    expect(result.context.windowEnd).toBeDefined()
  })

  it('filters out error spans from baseline selection', async () => {
    // 20 normal + 10 error → only 20 should be considered
    const normalSpans = Array.from({ length: 20 }, (_, i) =>
      makeSpan({
        traceId: `normal-${i}`,
        httpRoute: '/api/orders',
        httpMethod: 'POST',
        durationMs: 50,
      }),
    )
    const errorSpans = Array.from({ length: 10 }, (_, i) =>
      makeSpan({
        traceId: `error-${i}`,
        httpRoute: '/api/orders',
        httpMethod: 'POST',
        httpStatusCode: 500,
        spanStatusCode: 2,
        durationMs: 200,
      }),
    )
    const store = makeMockStore([...normalSpans, ...errorSpans])
    const result = await selectBaseline(store, BASE_QUERY)

    expect(result.context.source.kind).toBe('exact_operation')
    expect(result.context.sampleCount).toBe(20)
    for (const span of result.spans) {
      expect(span.httpStatusCode).not.toBe(500)
      expect(span.spanStatusCode).not.toBe(2)
    }
  })

  it('selects traces closest to median duration', async () => {
    const spans = [
      makeSpan({ traceId: 't-10', durationMs: 10, httpRoute: '/api/orders', httpMethod: 'POST' }),
      makeSpan({ traceId: 't-20', durationMs: 20, httpRoute: '/api/orders', httpMethod: 'POST' }),
      makeSpan({ traceId: 't-50', durationMs: 50, httpRoute: '/api/orders', httpMethod: 'POST' }),
      makeSpan({ traceId: 't-80', durationMs: 80, httpRoute: '/api/orders', httpMethod: 'POST' }),
      makeSpan({ traceId: 't-100', durationMs: 100, httpRoute: '/api/orders', httpMethod: 'POST' }),
    ]
    const store = makeMockStore(spans)
    const result = await selectBaseline(store, BASE_QUERY)

    const selectedTraceIds = new Set(result.spans.map((s) => s.traceId))
    expect(selectedTraceIds.size).toBe(3)
    expect(selectedTraceIds.has('t-50')).toBe(true)
  })

  it('handles query without operation (skips to none)', async () => {
    const queryNoOp: BaselineQuery = {
      incidentWindowStartMs: BASE_QUERY.incidentWindowStartMs,
      incidentWindowEndMs: BASE_QUERY.incidentWindowEndMs,
      primaryService: 'web',
    }
    const spans = Array.from({ length: 15 }, (_, i) =>
      makeSpan({ traceId: `trace-${i}`, durationMs: 40 + i }),
    )
    const store = makeMockStore(spans)
    const result = await selectBaseline(store, queryNoOp)

    expect(result.context.source).toEqual({ kind: 'none' })
  })

  it('queries the correct baseline window', async () => {
    const store = makeMockStore([])
    await selectBaseline(store, BASE_QUERY)

    const expectedWindow = computeBaselineWindow(
      BASE_QUERY.incidentWindowStartMs,
      BASE_QUERY.incidentWindowEndMs,
    )
    expect(store.querySpans).toHaveBeenCalledWith({
      startMs: expectedWindow.startMs,
      endMs: expectedWindow.endMs,
      services: ['web'],
    })
  })
})
