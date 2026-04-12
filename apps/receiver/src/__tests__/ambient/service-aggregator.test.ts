import { describe, it, expect } from 'vitest'
import { computeServices, computeActivity } from '../../ambient/service-aggregator.js'
import type { BufferedSpan } from '../../ambient/types.js'

function makeSpan(overrides: Partial<BufferedSpan> = {}): BufferedSpan {
  return {
    traceId: 'trace1',
    spanId: 'span1',
    serviceName: 'api',
    environment: 'production',
    spanStatusCode: 1,
    durationMs: 100,
    startTimeMs: 1700000000000,
    exceptionCount: 0,
    ingestedAt: 1700000000000,
    ...overrides,
  }
}

describe('computeServices', () => {
  it('returns [] for empty input', () => {
    expect(computeServices([])).toEqual([])
  })

  it('returns healthy for normal spans', () => {
    const now = 1700000300000 // 300s after span
    const spans = Array.from({ length: 10 }, (_, i) =>
      makeSpan({
        spanId: `span-${i}`,
        httpStatusCode: 200,
        durationMs: 100,
        ingestedAt: now - 100_000,
        startTimeMs: now - 100_000,
      }),
    )
    const result = computeServices(spans, now)
    expect(result.length).toBe(1)
    expect(result[0]!.name).toBe('api')
    expect(result[0]!.health).toBe('healthy')
    expect(result[0]!.errorRate).toBe(0)
  })

  it('returns degraded when errorRate >= 0.01', () => {
    const now = 1700000300000
    // 99 healthy + 1 error = 1% error rate
    const spans: BufferedSpan[] = []
    for (let i = 0; i < 99; i++) {
      spans.push(makeSpan({ spanId: `ok-${i}`, httpStatusCode: 200, ingestedAt: now - 50_000, startTimeMs: now - 50_000 }))
    }
    spans.push(makeSpan({ spanId: 'err-0', httpStatusCode: 500, ingestedAt: now - 50_000, startTimeMs: now - 50_000 }))

    const result = computeServices(spans, now)
    expect(result[0]!.errorRate).toBeCloseTo(0.01, 5)
    expect(result[0]!.health).toBe('degraded')
  })

  it('returns critical when errorRate >= 0.05', () => {
    const now = 1700000300000
    // 19 healthy + 1 error = 5% error rate
    const spans: BufferedSpan[] = []
    for (let i = 0; i < 19; i++) {
      spans.push(makeSpan({ spanId: `ok-${i}`, httpStatusCode: 200, ingestedAt: now - 50_000, startTimeMs: now - 50_000 }))
    }
    spans.push(makeSpan({ spanId: 'err-0', httpStatusCode: 500, ingestedAt: now - 50_000, startTimeMs: now - 50_000 }))

    const result = computeServices(spans, now)
    expect(result[0]!.errorRate).toBeCloseTo(0.05, 5)
    expect(result[0]!.health).toBe('critical')
  })

  it('returns degraded when p95Ms >= 2000', () => {
    const now = 1700000300000
    // 20 spans: 18 fast (100ms), 2 slow (2500ms).
    // p95 index = ceil(20*0.95)-1 = 18 → sorted[18] = 2500ms
    const spans: BufferedSpan[] = []
    for (let i = 0; i < 18; i++) {
      spans.push(makeSpan({ spanId: `fast-${i}`, durationMs: 100, ingestedAt: now - 50_000, startTimeMs: now - 50_000 }))
    }
    spans.push(makeSpan({ spanId: 'slow-0', durationMs: 2500, ingestedAt: now - 50_000, startTimeMs: now - 50_000 }))
    spans.push(makeSpan({ spanId: 'slow-1', durationMs: 2500, ingestedAt: now - 50_000, startTimeMs: now - 50_000 }))

    const result = computeServices(spans, now)
    expect(result[0]!.p95Ms).toBe(2500)
    expect(result[0]!.health).toBe('degraded')
  })

  it('returns critical when p95Ms >= 5000', () => {
    const now = 1700000300000
    // 20 spans: 18 fast (100ms), 2 slow (6000ms).
    // p95 index = ceil(20*0.95)-1 = 18 → sorted[18] = 6000ms
    const spans: BufferedSpan[] = []
    for (let i = 0; i < 18; i++) {
      spans.push(makeSpan({ spanId: `fast-${i}`, durationMs: 100, ingestedAt: now - 50_000, startTimeMs: now - 50_000 }))
    }
    spans.push(makeSpan({ spanId: 'slow-0', durationMs: 6000, ingestedAt: now - 50_000, startTimeMs: now - 50_000 }))
    spans.push(makeSpan({ spanId: 'slow-1', durationMs: 6000, ingestedAt: now - 50_000, startTimeMs: now - 50_000 }))

    const result = computeServices(spans, now)
    expect(result[0]!.p95Ms).toBe(6000)
    expect(result[0]!.health).toBe('critical')
  })

  it('error via 429 counts as error', () => {
    const now = 1700000300000
    const spans: BufferedSpan[] = []
    for (let i = 0; i < 19; i++) {
      spans.push(makeSpan({ spanId: `ok-${i}`, httpStatusCode: 200, ingestedAt: now - 50_000, startTimeMs: now - 50_000 }))
    }
    spans.push(makeSpan({ spanId: 'rate-limited', httpStatusCode: 429, ingestedAt: now - 50_000, startTimeMs: now - 50_000 }))

    const result = computeServices(spans, now)
    expect(result[0]!.errorRate).toBeCloseTo(0.05, 5)
  })

  it('error via spanStatusCode=2 counts as error', () => {
    const now = 1700000300000
    const spans: BufferedSpan[] = []
    for (let i = 0; i < 19; i++) {
      spans.push(makeSpan({ spanId: `ok-${i}`, httpStatusCode: 200, ingestedAt: now - 50_000, startTimeMs: now - 50_000 }))
    }
    spans.push(makeSpan({ spanId: 'status-err', spanStatusCode: 2, ingestedAt: now - 50_000, startTimeMs: now - 50_000 }))

    const result = computeServices(spans, now)
    expect(result[0]!.errorRate).toBeCloseTo(0.05, 5)
  })

  it('error via exceptionCount > 0 counts as error', () => {
    const now = 1700000300000
    const spans: BufferedSpan[] = []
    for (let i = 0; i < 19; i++) {
      spans.push(makeSpan({ spanId: `ok-${i}`, httpStatusCode: 200, ingestedAt: now - 50_000, startTimeMs: now - 50_000 }))
    }
    spans.push(makeSpan({ spanId: 'exc-err', exceptionCount: 2, ingestedAt: now - 50_000, startTimeMs: now - 50_000 }))

    const result = computeServices(spans, now)
    expect(result[0]!.errorRate).toBeCloseTo(0.05, 5)
  })

  it('trend array has length 6', () => {
    const now = 1700000300000
    const spans = [makeSpan({ ingestedAt: now - 50_000, startTimeMs: now - 50_000 })]
    const result = computeServices(spans, now)
    expect(result[0]!.trend).toHaveLength(6)
  })

  it('trend is oldest-first with correct req/s values', () => {
    // Place spans at known 1-minute buckets
    // Bucket boundaries (6 minutes before now):
    // bucket 0: [now - 360_000, now - 300_000)
    // bucket 1: [now - 300_000, now - 240_000)
    // bucket 2: [now - 240_000, now - 180_000)
    // bucket 3: [now - 180_000, now - 120_000)
    // bucket 4: [now - 120_000, now - 60_000)
    // bucket 5: [now - 60_000, now)
    const now = 1700000360000
    const spans: BufferedSpan[] = []

    // 2 spans in bucket 3 (now - 150_000)
    spans.push(makeSpan({ spanId: 'b3-0', ingestedAt: now - 150_000, startTimeMs: now - 150_000 }))
    spans.push(makeSpan({ spanId: 'b3-1', ingestedAt: now - 150_000, startTimeMs: now - 150_000 }))

    // 3 spans in bucket 5 (now - 30_000)
    spans.push(makeSpan({ spanId: 'b5-0', ingestedAt: now - 30_000, startTimeMs: now - 30_000 }))
    spans.push(makeSpan({ spanId: 'b5-1', ingestedAt: now - 30_000, startTimeMs: now - 30_000 }))
    spans.push(makeSpan({ spanId: 'b5-2', ingestedAt: now - 30_000, startTimeMs: now - 30_000 }))

    const result = computeServices(spans, now)
    const trend = result[0]!.trend
    expect(trend).toHaveLength(6)
    // bucket 0,1,2,4 = 0 spans
    expect(trend[0]!).toBe(0)
    expect(trend[1]!).toBe(0)
    expect(trend[2]!).toBe(0)
    expect(trend[4]!).toBe(0)
    // bucket 3 = 2/60
    expect(trend[3]!).toBeCloseTo(2 / 60, 5)
    // bucket 5 = 3/60
    expect(trend[5]!).toBeCloseTo(3 / 60, 5)
  })

  it('aggregates multiple services independently', () => {
    const now = 1700000300000
    const spans: BufferedSpan[] = [
      makeSpan({ serviceName: 'auth', spanId: 's1', httpStatusCode: 200, durationMs: 50, ingestedAt: now - 10_000, startTimeMs: now - 10_000 }),
      makeSpan({ serviceName: 'auth', spanId: 's2', httpStatusCode: 500, durationMs: 50, ingestedAt: now - 10_000, startTimeMs: now - 10_000 }),
      makeSpan({ serviceName: 'payments', spanId: 's3', httpStatusCode: 200, durationMs: 50, ingestedAt: now - 10_000, startTimeMs: now - 10_000 }),
    ]

    const result = computeServices(spans, now)
    expect(result.length).toBe(2)

    const auth = result.find((s) => s.name === 'auth')!
    const payments = result.find((s) => s.name === 'payments')!

    expect(auth.errorRate).toBeCloseTo(0.5, 5) // 1 of 2
    expect(payments.errorRate).toBe(0) // 0 of 1
  })
})

describe('computeActivity', () => {
  it('returns [] for empty input', () => {
    expect(computeActivity([], 10)).toEqual([])
  })

  it('returns at most limit entries, latest first', () => {
    const spans: BufferedSpan[] = Array.from({ length: 10 }, (_, i) =>
      makeSpan({
        spanId: `span-${i}`,
        startTimeMs: 1700000000000 + i * 1000,
        ingestedAt: 1700000000000 + i * 1000,
      }),
    )
    const result = computeActivity(spans, 5)
    expect(result.length).toBe(5)
    // latest first
    expect(result[0]!.ts).toBe(1700000000000 + 9000)
    expect(result[4]!.ts).toBe(1700000000000 + 5000)
  })

  it('sets anomalous correctly based on isAnomalous()', () => {
    const spans: BufferedSpan[] = [
      makeSpan({ spanId: 'ok', httpStatusCode: 200, startTimeMs: 1700000002000, ingestedAt: 1700000002000 }),
      makeSpan({ spanId: 'err', httpStatusCode: 500, startTimeMs: 1700000001000, ingestedAt: 1700000001000 }),
    ]
    const result = computeActivity(spans, 10)
    expect(result[0]!.anomalous).toBe(false) // 200
    expect(result[1]!.anomalous).toBe(true)  // 500
  })

  it('sets route to "" when httpRoute is undefined', () => {
    const spans: BufferedSpan[] = [
      makeSpan({ httpRoute: undefined, startTimeMs: 1700000000000, ingestedAt: 1700000000000 }),
    ]
    const result = computeActivity(spans, 10)
    expect(result[0]!.route).toBe('')
  })

  it('preserves undefined httpStatus when httpStatusCode is undefined', () => {
    const spans: BufferedSpan[] = [
      makeSpan({ httpStatusCode: undefined, startTimeMs: 1700000000000, ingestedAt: 1700000000000 }),
    ]
    const result = computeActivity(spans, 10)
    expect(result[0]!.httpStatus).toBeUndefined()
  })

  it('sorts by health severity desc, reqPerSec desc, name asc', () => {
    const now = 1700000300000
    // svc-b: critical (500 errors), svc-a: degraded (slow), svc-c: healthy
    const spans = [
      makeSpan({ serviceName: 'svc-c', startTimeMs: now - 1000, ingestedAt: now - 1000 }),
      makeSpan({ serviceName: 'svc-a', durationMs: 3000, startTimeMs: now - 1000, ingestedAt: now - 1000 }),
      makeSpan({ serviceName: 'svc-b', httpStatusCode: 500, startTimeMs: now - 1000, ingestedAt: now - 1000 }),
    ]
    const result = computeServices(spans, now)
    expect(result.map((s) => s.name)).toEqual(['svc-b', 'svc-a', 'svc-c'])
    expect(result[0]!.health).toBe('critical')
    expect(result[1]!.health).toBe('degraded')
    expect(result[2]!.health).toBe('healthy')
  })

  it('maps all RecentActivity fields correctly', () => {
    const span = makeSpan({
      spanId: 'x',
      traceId: 'trace-abc',
      serviceName: 'payments',
      httpRoute: '/checkout',
      httpStatusCode: 201,
      durationMs: 42,
      startTimeMs: 1700000005000,
      ingestedAt: 1700000005000,
    })
    const result = computeActivity([span], 10)
    expect(result[0]!).toEqual({
      ts: 1700000005000,
      service: 'payments',
      route: '/checkout',
      httpStatus: 201,
      durationMs: 42,
      traceId: 'trace-abc',
      anomalous: false,
    })
  })
})
