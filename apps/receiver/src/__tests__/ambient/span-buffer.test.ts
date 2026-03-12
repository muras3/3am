import { describe, it, expect } from 'vitest'
import { SpanBuffer } from '../../ambient/span-buffer.js'
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
    ingestedAt: Date.now(),
    ...overrides,
  }
}

describe('SpanBuffer', () => {
  it('returns [] when empty', () => {
    const buf = new SpanBuffer()
    expect(buf.getAll()).toEqual([])
  })

  it('returns pushed spans', () => {
    const buf = new SpanBuffer()
    const span = makeSpan()
    buf.push(span)
    expect(buf.getAll()).toEqual([span])
  })

  it('evicts oldest span when capacity (1000) is exceeded', () => {
    const buf = new SpanBuffer()
    const now = 1700000000000

    for (let i = 0; i < 1000; i++) {
      buf.push(makeSpan({ spanId: `span-${i}`, ingestedAt: now + i }))
    }
    expect(buf.getAll(now + 999).length).toBe(1000)

    // Push one more — oldest (span-0) should be evicted
    buf.push(makeSpan({ spanId: 'span-1000', ingestedAt: now + 1000 }))
    const all = buf.getAll(now + 1000)
    expect(all.length).toBe(1000)
    expect(all.find((s) => s.spanId === 'span-0')).toBeUndefined()
    expect(all.find((s) => s.spanId === 'span-1000')).toBeDefined()
  })

  it('excludes spans older than TTL (300,000 ms)', () => {
    const buf = new SpanBuffer()
    const now = 1700000000000

    buf.push(makeSpan({ spanId: 'old', ingestedAt: now - 300_001 }))
    buf.push(makeSpan({ spanId: 'fresh', ingestedAt: now - 100_000 }))

    const result = buf.getAll(now)
    expect(result.length).toBe(1)
    expect(result[0].spanId).toBe('fresh')
  })

  it('includes spans within TTL', () => {
    const buf = new SpanBuffer()
    const now = 1700000000000

    buf.push(makeSpan({ spanId: 'boundary', ingestedAt: now - 300_000 }))
    const result = buf.getAll(now)
    expect(result.length).toBe(1)
    expect(result[0].spanId).toBe('boundary')
  })

  it('filters mixed TTL spans correctly', () => {
    const buf = new SpanBuffer()
    const now = 1700000000000

    buf.push(makeSpan({ spanId: 'expired-1', ingestedAt: now - 400_000 }))
    buf.push(makeSpan({ spanId: 'expired-2', ingestedAt: now - 350_000 }))
    buf.push(makeSpan({ spanId: 'valid-1', ingestedAt: now - 200_000 }))
    buf.push(makeSpan({ spanId: 'valid-2', ingestedAt: now - 100_000 }))
    buf.push(makeSpan({ spanId: 'valid-3', ingestedAt: now }))

    const result = buf.getAll(now)
    expect(result.length).toBe(3)
    expect(result.map((s) => s.spanId)).toEqual(['valid-1', 'valid-2', 'valid-3'])
  })
})
