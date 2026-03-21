import { describe, it, expect, vi } from 'vitest'
import { detectAbsences } from '../../domain/absence-detector.js'
import type { TelemetryLog, TelemetryStoreDriver } from '../../telemetry/interface.js'
import type { TelemetryScope, AnomalousSignal } from '../../storage/interface.js'

// ── Helpers ─────────────────────────────────────────────────────────────

function makeLog(overrides: Partial<TelemetryLog> = {}): TelemetryLog {
  return {
    service: 'web',
    environment: 'production',
    timestamp: '2025-03-07T16:05:00.000Z',
    startTimeMs: 1741392300000,
    severity: 'ERROR',
    severityNumber: 17,
    body: 'something went wrong',
    bodyHash: 'abc123',
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

function makeSignal(overrides: Partial<AnomalousSignal> = {}): AnomalousSignal {
  return {
    signal: 'http_429',
    firstSeenAt: '2025-03-07T16:05:00.000Z',
    entity: 'web',
    spanId: 'span-1',
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
  }
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('detectAbsences', () => {
  it('detects absence when 429 signal present and no "retry" in logs', async () => {
    const store = makeMockStore([
      makeLog({ body: 'Request failed with status 429' }),
    ])
    const scope = makeScope()
    const signals = [makeSignal({ signal: 'http_429' })]

    const result = await detectAbsences(store, scope, signals)

    // no-retry should trigger (signal includes "429"), and "retry" not found in log body
    const noRetry = result.entries.find((e) => e.patternId === 'no-retry')
    expect(noRetry).toBeDefined()
    expect(noRetry!.kind).toBe('absence')
    expect(noRetry!.matchCount).toBe(0)
    expect(noRetry!.keywords).toContain('retry')
    expect(noRetry!.searchWindow.start).toBeDefined()
    expect(noRetry!.searchWindow.end).toBeDefined()
    expect(noRetry!.diagnosisLabel).toBeUndefined()
    expect(noRetry!.diagnosisExpected).toBeUndefined()
    expect(noRetry!.diagnosisExplanation).toBeUndefined()
  })

  it('does NOT detect absence when "retry" keyword found in logs', async () => {
    const store = makeMockStore([
      makeLog({ body: 'Retry attempt 3 for Stripe API call' }),
    ])
    const scope = makeScope()
    const signals = [makeSignal({ signal: 'http_429' })]

    const result = await detectAbsences(store, scope, signals)

    const noRetry = result.entries.find((e) => e.patternId === 'no-retry')
    expect(noRetry).toBeUndefined()
  })

  it('skips no-rate-limit pattern when no 429 signal present', async () => {
    const store = makeMockStore([])
    const scope = makeScope()
    const signals = [makeSignal({ signal: 'http_500' })]

    const result = await detectAbsences(store, scope, signals)

    const noRateLimit = result.entries.find((e) => e.patternId === 'no-rate-limit')
    expect(noRateLimit).toBeUndefined()
  })

  it('health check pattern always runs regardless of signals', async () => {
    const store = makeMockStore([])
    const scope = makeScope()
    const signals: AnomalousSignal[] = [] // no signals at all

    const result = await detectAbsences(store, scope, signals)

    // Only health check should run (no signals → other patterns skip)
    const healthCheck = result.entries.find((e) => e.patternId === 'no-health-check-failure')
    expect(healthCheck).toBeDefined()
    expect(healthCheck!.matchCount).toBe(0)
  })

  it('performs case-insensitive keyword matching', async () => {
    const store = makeMockStore([
      makeLog({ body: 'HEALTHCHECK endpoint returned 200' }),
    ])
    const scope = makeScope()
    const signals: AnomalousSignal[] = []

    const result = await detectAbsences(store, scope, signals)

    // "healthcheck" keyword in pattern should match "HEALTHCHECK" in body
    const healthCheck = result.entries.find((e) => e.patternId === 'no-health-check-failure')
    expect(healthCheck).toBeUndefined()
  })

  it('multiple patterns can trigger simultaneously', async () => {
    const store = makeMockStore([
      makeLog({ body: 'Error processing payment' }),
    ])
    const scope = makeScope()
    const signals = [makeSignal({ signal: 'http_429' })]

    const result = await detectAbsences(store, scope, signals)

    // With http_429 signal: no-retry, no-rate-limit, no-health-check, no-fallback all trigger
    // None of the keywords found in "Error processing payment"
    const patternIds = result.entries.map((e) => e.patternId)
    expect(patternIds).toContain('no-retry')
    expect(patternIds).toContain('no-rate-limit')
    expect(patternIds).toContain('no-health-check-failure')
    expect(patternIds).toContain('no-fallback')
  })

  it('only health-check runs when no signals provided', async () => {
    const store = makeMockStore([])
    const scope = makeScope()
    const signals: AnomalousSignal[] = []

    const result = await detectAbsences(store, scope, signals)

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].patternId).toBe('no-health-check-failure')
  })

  it('builds EvidenceRef map for detected absences', async () => {
    const store = makeMockStore([])
    const scope = makeScope()
    const signals = [makeSignal({ signal: 'http_429' })]

    const result = await detectAbsences(store, scope, signals)

    // All absence entries should have corresponding evidenceRefs
    for (const entry of result.entries) {
      const ref = result.evidenceRefs.get(entry.patternId)
      expect(ref).toBeDefined()
      expect(ref!.surface).toBe('absences')
      expect(ref!.refId).toBe(entry.patternId)
    }
  })

  it('no-fallback triggers on http_500 signal', async () => {
    const store = makeMockStore([])
    const scope = makeScope()
    const signals = [makeSignal({ signal: 'http_500' })]

    const result = await detectAbsences(store, scope, signals)

    const noFallback = result.entries.find((e) => e.patternId === 'no-fallback')
    expect(noFallback).toBeDefined()
  })

  it('no-fallback does NOT trigger on http_200 signal', async () => {
    const store = makeMockStore([])
    const scope = makeScope()
    // A signal that doesn't contain "5" or isn't "http_429"
    const signals = [makeSignal({ signal: 'http_200' })]

    const result = await detectAbsences(store, scope, signals)

    const noFallback = result.entries.find((e) => e.patternId === 'no-fallback')
    expect(noFallback).toBeUndefined()
  })

  it('defaultLabel contains search window timestamps', async () => {
    const store = makeMockStore([])
    const scope = makeScope()
    const signals: AnomalousSignal[] = []

    const result = await detectAbsences(store, scope, signals)

    const entry = result.entries[0] // health check
    expect(entry.defaultLabel).toContain(new Date(scope.windowStartMs).toISOString())
    expect(entry.defaultLabel).toContain(new Date(scope.windowEndMs).toISOString())
  })
})
