import { describe, it, expect } from 'vitest'
import { scoreLogs } from '../../../telemetry/scoring/log-scorer.js'
import type { TelemetryLog } from '../../../telemetry/interface.js'
import {
  LOG_SEVERITY_WEIGHTS,
  TEMPORAL_LAMBDA,
  TRACE_CORRELATION_BONUS,
  KEYWORD_BONUS,
} from '../../../telemetry/constants.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let bodyHashCounter = 0

function makeLog(overrides: Partial<TelemetryLog> = {}): TelemetryLog {
  bodyHashCounter++
  return {
    service: overrides.service ?? 'api-service',
    environment: overrides.environment ?? 'production',
    timestamp: overrides.timestamp ?? new Date(1700000000000).toISOString(),
    startTimeMs: overrides.startTimeMs ?? 1700000000000,
    severity: overrides.severity ?? 'ERROR',
    severityNumber: overrides.severityNumber ?? 17,
    body: overrides.body ?? `Error occurred in handler ${bodyHashCounter}`,
    bodyHash: overrides.bodyHash ?? `hash_${bodyHashCounter.toString().padStart(12, '0')}`,
    attributes: overrides.attributes ?? {},
    traceId: overrides.traceId,
    spanId: overrides.spanId,
    ingestedAt: overrides.ingestedAt ?? Date.now(),
  }
}

const DETECT_TIME_MS = 1700000000000

// ---------------------------------------------------------------------------
// Severity weight mapping
// ---------------------------------------------------------------------------

describe('scoreLogs', () => {
  describe('severity weights', () => {
    it('FATAL scores higher than ERROR, which scores higher than WARN', () => {
      const logs = [
        makeLog({ severity: 'FATAL', severityNumber: 21, bodyHash: 'hash_fatal_000001' }),
        makeLog({ severity: 'ERROR', severityNumber: 17, bodyHash: 'hash_error_000001' }),
        makeLog({ severity: 'WARN', severityNumber: 13, bodyHash: 'hash_warn_0000001' }),
      ]

      const result = scoreLogs(logs, DETECT_TIME_MS, new Set())

      expect(result).toHaveLength(3)
      // All at same temporal proximity (startTimeMs = detectTimeMs → delta=0 → exp(0) = 1)
      // So score is purely severity_weight * 1 * (1 + log2(1)) = severity_weight * 1 * 1
      const fatalScore = result.find(r => r.severity === 'FATAL')!.score
      const errorScore = result.find(r => r.severity === 'ERROR')!.score
      const warnScore = result.find(r => r.severity === 'WARN')!.score

      expect(fatalScore).toBeGreaterThan(errorScore)
      expect(errorScore).toBeGreaterThan(warnScore)
    })

    it('applies correct severity weight values', () => {
      // At detectTime (temporal_proximity = 1.0), count=1 (count_factor = 1.0)
      // score = severity_weight * 1.0 * 1.0 = severity_weight
      const fatalLog = makeLog({
        severity: 'FATAL',
        severityNumber: 21,
        bodyHash: 'hash_fatal_val_01',
      })

      const result = scoreLogs([fatalLog], DETECT_TIME_MS, new Set())
      expect(result).toHaveLength(1)
      expect(result[0]!.score).toBeCloseTo(LOG_SEVERITY_WEIGHTS['FATAL']!)
    })
  })

  // ---------------------------------------------------------------------------
  // Temporal proximity decay
  // ---------------------------------------------------------------------------

  describe('temporal proximity', () => {
    it('gives score 1.0 at detect time (delta=0)', () => {
      const log = makeLog({
        startTimeMs: DETECT_TIME_MS,
        severity: 'ERROR',
        bodyHash: 'hash_temporal_0s0',
      })

      const result = scoreLogs([log], DETECT_TIME_MS, new Set())
      // temporal_proximity = exp(0) = 1.0
      // score = 2.0 * 1.0 * 1.0 = 2.0
      expect(result[0]!.score).toBeCloseTo(2.0)
    })

    it('decays with known delta-t values', () => {
      // lambda = 0.001/sec
      // delta = 300s → temporal = exp(-0.001 * 300) = exp(-0.3) ≈ 0.7408
      // delta = 1800s → temporal = exp(-0.001 * 1800) = exp(-1.8) ≈ 0.1653
      const log300s = makeLog({
        startTimeMs: DETECT_TIME_MS - 300_000, // 300s before
        severity: 'ERROR',
        bodyHash: 'hash_temporal_300',
      })
      const log1800s = makeLog({
        startTimeMs: DETECT_TIME_MS - 1_800_000, // 1800s before
        severity: 'ERROR',
        bodyHash: 'hash_tempora1800',
      })

      const result300 = scoreLogs([log300s], DETECT_TIME_MS, new Set())
      const result1800 = scoreLogs([log1800s], DETECT_TIME_MS, new Set())

      // score = severity(2.0) * temporal * count_factor(1.0)
      const expectedScore300 = 2.0 * Math.exp(-TEMPORAL_LAMBDA * 300)
      const expectedScore1800 = 2.0 * Math.exp(-TEMPORAL_LAMBDA * 1800)

      expect(result300[0]!.score).toBeCloseTo(expectedScore300, 4)
      expect(result1800[0]!.score).toBeCloseTo(expectedScore1800, 4)
    })

    it('decays symmetrically for logs after detect time', () => {
      const logBefore = makeLog({
        startTimeMs: DETECT_TIME_MS - 60_000, // 60s before
        severity: 'ERROR',
        bodyHash: 'hash_sym_before0',
      })
      const logAfter = makeLog({
        startTimeMs: DETECT_TIME_MS + 60_000, // 60s after
        severity: 'ERROR',
        bodyHash: 'hash_sym_after00',
      })

      const resultBefore = scoreLogs([logBefore], DETECT_TIME_MS, new Set())
      const resultAfter = scoreLogs([logAfter], DETECT_TIME_MS, new Set())

      // Both should have the same score (symmetric about detect time)
      expect(resultBefore[0]!.score).toBeCloseTo(resultAfter[0]!.score)
    })
  })

  // ---------------------------------------------------------------------------
  // Dedup grouping by bodyHash
  // ---------------------------------------------------------------------------

  describe('dedup by bodyHash', () => {
    it('groups logs with same bodyHash into one scored entry', () => {
      const sharedHash = 'hash_dedup_00001'
      const logs = [
        makeLog({ bodyHash: sharedHash, startTimeMs: DETECT_TIME_MS }),
        makeLog({ bodyHash: sharedHash, startTimeMs: DETECT_TIME_MS + 1000 }),
        makeLog({ bodyHash: sharedHash, startTimeMs: DETECT_TIME_MS + 2000 }),
      ]

      const result = scoreLogs(logs, DETECT_TIME_MS, new Set())
      expect(result).toHaveLength(1)
      expect(result[0]!.groupCount).toBe(3)
    })

    it('selects representative with highest severity', () => {
      const sharedHash = 'hash_repr_sever0'
      const logs = [
        makeLog({ bodyHash: sharedHash, severity: 'WARN', severityNumber: 13 }),
        makeLog({ bodyHash: sharedHash, severity: 'ERROR', severityNumber: 17 }),
        makeLog({ bodyHash: sharedHash, severity: 'WARN', severityNumber: 13 }),
      ]

      const result = scoreLogs(logs, DETECT_TIME_MS, new Set())
      expect(result).toHaveLength(1)
      expect(result[0]!.severity).toBe('ERROR')
    })

    it('selects earliest timestamp when severities are equal', () => {
      const sharedHash = 'hash_repr_times0'
      const logs = [
        makeLog({ bodyHash: sharedHash, severity: 'ERROR', startTimeMs: DETECT_TIME_MS + 2000 }),
        makeLog({ bodyHash: sharedHash, severity: 'ERROR', startTimeMs: DETECT_TIME_MS }),
        makeLog({ bodyHash: sharedHash, severity: 'ERROR', startTimeMs: DETECT_TIME_MS + 1000 }),
      ]

      const result = scoreLogs(logs, DETECT_TIME_MS, new Set())
      expect(result).toHaveLength(1)
      expect(result[0]!.startTimeMs).toBe(DETECT_TIME_MS)
    })

    it('applies count_factor = 1 + log2(count)', () => {
      const sharedHash = 'hash_count_fact0'
      // 8 logs with same hash → count_factor = 1 + log2(8) = 1 + 3 = 4
      const logs = Array.from({ length: 8 }, () =>
        makeLog({ bodyHash: sharedHash, severity: 'ERROR', startTimeMs: DETECT_TIME_MS }),
      )

      const result = scoreLogs(logs, DETECT_TIME_MS, new Set())
      // score = severity(2.0) * temporal(1.0) * count_factor(4.0) = 8.0
      expect(result[0]!.score).toBeCloseTo(8.0)
      expect(result[0]!.groupCount).toBe(8)
    })

    it('handles all logs having the same bodyHash', () => {
      const sharedHash = 'hash_all_same_00'
      const logs = [
        makeLog({ bodyHash: sharedHash, severity: 'WARN' }),
        makeLog({ bodyHash: sharedHash, severity: 'ERROR' }),
        makeLog({ bodyHash: sharedHash, severity: 'FATAL' }),
      ]

      const result = scoreLogs(logs, DETECT_TIME_MS, new Set())
      expect(result).toHaveLength(1)
      expect(result[0]!.groupCount).toBe(3)
      // Representative should be FATAL (highest severity)
      expect(result[0]!.severity).toBe('FATAL')
    })
  })

  // ---------------------------------------------------------------------------
  // Trace correlation bonus
  // ---------------------------------------------------------------------------

  describe('trace correlation bonus', () => {
    it('adds bonus when traceId matches an anomalous trace', () => {
      const anomalousTraceId = 'abc123def4567890abc123def4567890'
      const logWithTrace = makeLog({
        traceId: anomalousTraceId,
        bodyHash: 'hash_trace_bon00',
      })
      const logWithoutTrace = makeLog({
        traceId: undefined,
        bodyHash: 'hash_trace_bon01',
      })

      const anomalousTraceIds = new Set([anomalousTraceId])
      const result = scoreLogs([logWithTrace, logWithoutTrace], DETECT_TIME_MS, anomalousTraceIds)

      const withTraceScore = result.find(r => r.traceId === anomalousTraceId)!.score
      const withoutTraceScore = result.find(r => r.traceId === undefined)!.score

      expect(withTraceScore - withoutTraceScore).toBeCloseTo(TRACE_CORRELATION_BONUS)
    })

    it('does not add bonus when traceId does not match', () => {
      const nonMatchingTraceId = '000000000000000000000000deadbeef'
      const log = makeLog({
        traceId: nonMatchingTraceId,
        bodyHash: 'hash_trace_nomch',
      })

      const anomalousTraceIds = new Set(['abc123def4567890abc123def4567890'])
      const resultWithSet = scoreLogs([log], DETECT_TIME_MS, anomalousTraceIds)
      const resultEmpty = scoreLogs([log], DETECT_TIME_MS, new Set())

      expect(resultWithSet[0]!.score).toBeCloseTo(resultEmpty[0]!.score)
    })

    it('does not add bonus when traceId is undefined', () => {
      const log = makeLog({
        traceId: undefined,
        bodyHash: 'hash_trace_undef',
      })

      const anomalousTraceIds = new Set(['abc123def4567890abc123def4567890'])
      const result = scoreLogs([log], DETECT_TIME_MS, anomalousTraceIds)

      // score should be purely severity * temporal * count, no trace bonus
      const expected = LOG_SEVERITY_WEIGHTS['ERROR']! * 1.0 * 1.0
      expect(result[0]!.score).toBeCloseTo(expected)
    })
  })

  // ---------------------------------------------------------------------------
  // Keyword bonus
  // ---------------------------------------------------------------------------

  describe('keyword bonus', () => {
    it('adds bonus for diagnostic keywords (case-insensitive)', () => {
      const logWithKeyword = makeLog({
        body: 'Connection TIMEOUT after 5000ms',
        bodyHash: 'hash_keyword_to0',
      })
      const logWithoutKeyword = makeLog({
        body: 'Request processed successfully',
        bodyHash: 'hash_keyword_no0',
      })

      const result = scoreLogs(
        [logWithKeyword, logWithoutKeyword],
        DETECT_TIME_MS,
        new Set(),
      )

      const withKwScore = result.find(r => r.bodyHash === 'hash_keyword_to0')!.score
      const withoutKwScore = result.find(r => r.bodyHash === 'hash_keyword_no0')!.score

      expect(withKwScore - withoutKwScore).toBeCloseTo(KEYWORD_BONUS)
    })

    it('detects all configured keywords', () => {
      const keywords = [
        'timeout',
        'connection refused',
        'rate limit',
        'OOM',
        'circuit breaker',
        'deadline exceeded',
        'pool exhausted',
      ]

      for (const keyword of keywords) {
        const log = makeLog({
          body: `Failed: ${keyword} encountered`,
          bodyHash: `hash_kw_${keyword.replace(/\s/g, '_').slice(0, 6)}`,
        })
        const result = scoreLogs([log], DETECT_TIME_MS, new Set())
        // Should have keyword bonus added to base score
        const baseScore = LOG_SEVERITY_WEIGHTS['ERROR']! * 1.0 * 1.0
        expect(result[0]!.score).toBeCloseTo(baseScore + KEYWORD_BONUS)
      }
    })

    it('does not add bonus when body has no keywords', () => {
      const log = makeLog({
        body: 'Processing request for user',
        bodyHash: 'hash_no_keyword0',
      })

      const result = scoreLogs([log], DETECT_TIME_MS, new Set())
      const expectedBase = LOG_SEVERITY_WEIGHTS['ERROR']! * 1.0 * 1.0
      expect(result[0]!.score).toBeCloseTo(expectedBase)
    })
  })

  // ---------------------------------------------------------------------------
  // Combined scoring
  // ---------------------------------------------------------------------------

  describe('combined scoring', () => {
    it('combines all score components correctly', () => {
      const anomalousTraceId = 'abc123def4567890abc123def4567890'
      const log = makeLog({
        severity: 'FATAL',
        severityNumber: 21,
        startTimeMs: DETECT_TIME_MS, // temporal = 1.0
        body: 'OOM killed process',
        traceId: anomalousTraceId,
        bodyHash: 'hash_combined_00',
      })

      const result = scoreLogs([log], DETECT_TIME_MS, new Set([anomalousTraceId]))
      expect(result).toHaveLength(1)

      // severity(3.0) * temporal(1.0) * count_factor(1.0) + trace(2.0) + keyword(1.0)
      const expected = 3.0 * 1.0 * 1.0 + TRACE_CORRELATION_BONUS + KEYWORD_BONUS
      expect(result[0]!.score).toBeCloseTo(expected)
    })

    it('sorts results by score descending', () => {
      const logs = [
        makeLog({
          severity: 'WARN',
          severityNumber: 13,
          bodyHash: 'hash_sort_warn00',
          body: 'Minor warning',
        }),
        makeLog({
          severity: 'FATAL',
          severityNumber: 21,
          bodyHash: 'hash_sort_fatal0',
          body: 'OOM killed',
        }),
        makeLog({
          severity: 'ERROR',
          severityNumber: 17,
          bodyHash: 'hash_sort_error0',
          body: 'Request failed',
        }),
      ]

      const result = scoreLogs(logs, DETECT_TIME_MS, new Set())
      expect(result[0]!.severity).toBe('FATAL')
      expect(result[1]!.severity).toBe('ERROR')
      expect(result[2]!.severity).toBe('WARN')
    })

    it('uses timestamp ascending as tie-breaker', () => {
      // Both have same severity and very similar temporal proximity
      // With exactly same delta magnitude but different signs, temporal is slightly different
      // Let's use same delta so score is equal
      const log1 = makeLog({
        severity: 'ERROR',
        startTimeMs: DETECT_TIME_MS + 5000,
        bodyHash: 'hash_tiebreak_03',
      })
      const log2 = makeLog({
        severity: 'ERROR',
        startTimeMs: DETECT_TIME_MS - 5000,
        bodyHash: 'hash_tiebreak_04',
      })

      const result = scoreLogs([log1, log2], DETECT_TIME_MS, new Set())
      // Both have same |delta| = 5000ms, so same temporal proximity and same score
      // Tie-break: earlier startTimeMs first
      expect(result[0]!.startTimeMs).toBeLessThan(result[1]!.startTimeMs)
    })
  })

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('returns empty array for empty logs', () => {
      const result = scoreLogs([], DETECT_TIME_MS, new Set())
      expect(result).toHaveLength(0)
    })

    it('handles unknown severity gracefully (weight defaults to 0)', () => {
      const log = makeLog({
        severity: 'DEBUG',
        severityNumber: 5,
        bodyHash: 'hash_unknown_sev',
      })

      const result = scoreLogs([log], DETECT_TIME_MS, new Set())
      expect(result).toHaveLength(1)
      // Severity weight for DEBUG is 0 (not in LOG_SEVERITY_WEIGHTS)
      // score = 0 * temporal * count = 0
      expect(result[0]!.score).toBe(0)
    })

    it('handles single log correctly', () => {
      const log = makeLog({ bodyHash: 'hash_single_log0' })
      const result = scoreLogs([log], DETECT_TIME_MS, new Set())
      expect(result).toHaveLength(1)
      expect(result[0]!.groupCount).toBe(1)
    })

    it('handles very large time delta without numerical issues', () => {
      const log = makeLog({
        startTimeMs: DETECT_TIME_MS - 86_400_000, // 24 hours before
        bodyHash: 'hash_large_delta',
      })

      const result = scoreLogs([log], DETECT_TIME_MS, new Set())
      expect(result).toHaveLength(1)
      expect(Number.isFinite(result[0]!.score)).toBe(true)
      // Score should be very small due to temporal decay
      expect(result[0]!.score).toBeGreaterThanOrEqual(0)
    })

    it('handles multiple groups with different bodyHashes', () => {
      const logs = [
        makeLog({ bodyHash: 'hash_group_a0000', severity: 'ERROR' }),
        makeLog({ bodyHash: 'hash_group_b0000', severity: 'WARN' }),
        makeLog({ bodyHash: 'hash_group_c0000', severity: 'FATAL' }),
      ]

      const result = scoreLogs(logs, DETECT_TIME_MS, new Set())
      expect(result).toHaveLength(3)
      // Each should have groupCount = 1
      result.forEach(r => expect(r.groupCount).toBe(1))
    })

    it('preserves log fields in scored output', () => {
      const log = makeLog({
        service: 'payment-service',
        environment: 'staging',
        severity: 'ERROR',
        body: 'Payment failed: timeout',
        bodyHash: 'hash_preserve_00',
        traceId: 'trace123',
        spanId: 'span456',
        attributes: { key: 'value' },
      })

      const result = scoreLogs([log], DETECT_TIME_MS, new Set())
      expect(result[0]!.service).toBe('payment-service')
      expect(result[0]!.environment).toBe('staging')
      expect(result[0]!.severity).toBe('ERROR')
      expect(result[0]!.body).toBe('Payment failed: timeout')
      expect(result[0]!.traceId).toBe('trace123')
      expect(result[0]!.spanId).toBe('span456')
      expect(result[0]!.attributes).toEqual({ key: 'value' })
    })
  })
})
