/**
 * absence-detector.ts — Detects the absence of expected defensive patterns in logs.
 *
 * Phase 1 uses a hardcoded set of absence patterns. Each pattern specifies
 * trigger conditions (based on anomalous signals) and keywords to search for
 * in log bodies. When a pattern triggers and zero matching log entries are
 * found, an AbsenceEvidenceEntry is emitted — indicating a defensive
 * mechanism that was expected but not observed.
 */

import type { TelemetryLog, TelemetryStoreDriver } from '../telemetry/interface.js'
import { buildIncidentQueryFilter } from '../telemetry/interface.js'
import type { TelemetryScope, AnomalousSignal } from '../storage/interface.js'
import type { AbsenceEvidenceEntry, EvidenceRef } from '@3amoncall/core'

// ── Pattern Definitions ─────────────────────────────────────────────────

interface AbsencePattern {
  patternId: string
  keywords: string[]
  triggerCondition: (signals: AnomalousSignal[]) => boolean
  defaultLabelFn: (window: { start: string; end: string }) => string
}

const ABSENCE_PATTERNS: AbsencePattern[] = [
  {
    patternId: 'no-retry',
    keywords: ['retry', 'backoff', 'circuit_breaker', 'circuit-breaker', 'CircuitBreaker'],
    triggerCondition: (signals) =>
      signals.some((s) => s.signal.includes('429') || s.signal.includes('5')),
    defaultLabelFn: (window) =>
      `0 entries matching [retry, backoff, circuit_breaker] in ${window.start}-${window.end}`,
  },
  {
    patternId: 'no-rate-limit',
    keywords: ['rate_limit', 'rate-limit', 'throttle', 'RateLimiter'],
    triggerCondition: (signals) => signals.some((s) => s.signal === 'http_429'),
    defaultLabelFn: (window) =>
      `0 entries matching [rate_limit, throttle] in ${window.start}-${window.end}`,
  },
  {
    patternId: 'no-health-check-failure',
    keywords: ['health', 'healthcheck', 'readiness', 'liveness'],
    triggerCondition: () => true, // always check
    defaultLabelFn: (window) =>
      `0 entries matching [healthcheck, readiness] in ${window.start}-${window.end}`,
  },
  {
    patternId: 'no-fallback',
    keywords: ['fallback', 'degraded', 'failover'],
    triggerCondition: (signals) =>
      signals.some((s) => s.signal.includes('5') || s.signal === 'http_429'),
    defaultLabelFn: (window) =>
      `0 entries matching [fallback, failover] in ${window.start}-${window.end}`,
  },
]

// ── Keyword matching ────────────────────────────────────────────────────

/**
 * Check if any log body contains any of the given keywords (case-insensitive).
 */
function logsContainKeyword(logs: TelemetryLog[], keywords: string[]): boolean {
  const lowerKeywords = keywords.map((kw) => kw.toLowerCase())
  for (const log of logs) {
    const lowerBody = log.body.toLowerCase()
    if (lowerKeywords.some((kw) => lowerBody.includes(kw))) {
      return true
    }
  }
  return false
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Detect absence of expected defensive patterns in incident logs.
 *
 * For each hardcoded pattern:
 * 1. Check if triggerCondition(anomalousSignals) is true
 * 2. If yes, search logs for any keyword match
 * 3. If matchCount === 0, emit an AbsenceEvidenceEntry
 */
export async function detectAbsences(
  telemetryStore: TelemetryStoreDriver,
  telemetryScope: TelemetryScope,
  anomalousSignals: AnomalousSignal[],
): Promise<{ entries: AbsenceEvidenceEntry[]; evidenceRefs: Map<string, EvidenceRef> }> {
  const entries: AbsenceEvidenceEntry[] = []
  const evidenceRefs = new Map<string, EvidenceRef>()

  // Build search window
  const searchWindow = {
    start: new Date(telemetryScope.windowStartMs).toISOString(),
    end: new Date(telemetryScope.windowEndMs).toISOString(),
  }

  // Query logs once for all patterns
  const filter = buildIncidentQueryFilter(telemetryScope)
  const logs = await telemetryStore.queryLogs(filter)

  for (const pattern of ABSENCE_PATTERNS) {
    // Skip if trigger condition not met
    if (!pattern.triggerCondition(anomalousSignals)) continue

    // Case-insensitive search for pattern keywords
    const found = logsContainKeyword(logs, pattern.keywords)

    if (!found) {
      const entry: AbsenceEvidenceEntry = {
        refId: pattern.patternId,
        kind: 'absence',
        patternId: pattern.patternId,
        keywords: pattern.keywords,
        matchCount: 0,
        searchWindow,
        defaultLabel: pattern.defaultLabelFn(searchWindow),
        diagnosisLabel: undefined,
        diagnosisExpected: undefined,
        diagnosisExplanation: undefined,
      }

      entries.push(entry)
      evidenceRefs.set(pattern.patternId, {
        refId: pattern.patternId,
        surface: 'absences',
      })
    }
  }

  return { entries, evidenceRefs }
}

// ── Exported for testing ────────────────────────────────────────────────

export { ABSENCE_PATTERNS }
export type { AbsencePattern }
