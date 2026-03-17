/**
 * log-scorer.ts — severity x temporal x count + trace correlation + keyword scoring
 *
 * ADR 0032 Decision 5.2: Logs are deduplicated by bodyHash, then scored by
 * severity weight, temporal proximity to detection time, group count,
 * trace correlation with anomalous spans, and diagnostic keyword presence.
 *
 * Pure functions with no side effects or I/O.
 */

import type { TelemetryLog } from '../interface.js'
import {
  LOG_SEVERITY_WEIGHTS,
  TEMPORAL_LAMBDA,
  TRACE_CORRELATION_BONUS,
  KEYWORD_BONUS,
  LOG_KEYWORDS,
} from '../constants.js'

// ---------------------------------------------------------------------------
// Scored type
// ---------------------------------------------------------------------------

export type ScoredLog = TelemetryLog & { score: number; groupCount: number }

// ---------------------------------------------------------------------------
// Keyword matching
// ---------------------------------------------------------------------------

/** Pre-compiled lowercase keyword patterns for efficient matching. */
const KEYWORD_PATTERNS = LOG_KEYWORDS.map(kw => kw.toLowerCase())

/**
 * Check if a log body contains any diagnostic keyword (case-insensitive).
 */
function hasKeywordMatch(body: string): boolean {
  const lower = body.toLowerCase()
  return KEYWORD_PATTERNS.some(kw => lower.includes(kw))
}

// ---------------------------------------------------------------------------
// Internal: severity comparison for representative selection
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<string, number> = {
  FATAL: 3,
  ERROR: 2,
  WARN: 1,
}

function severityRank(severity: string): number {
  return SEVERITY_RANK[severity.toUpperCase()] ?? 0
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Score and deduplicate logs for incident evidence selection.
 *
 * Steps:
 * 1. Group by bodyHash (dedup). For each group, keep the representative
 *    with the highest severity (then earliest timestamp). Store groupCount.
 * 2. Score each group:
 *    - severity_weight × temporal_proximity × count_factor
 *    - + trace_correlation_bonus (if traceId matches an anomalous trace)
 *    - + keyword_bonus (if body contains a diagnostic keyword)
 * 3. Return one scored entry per group.
 *
 * @param logs - All logs within the incident time window
 * @param detectTimeMs - Incident detection timestamp (epoch ms)
 * @param anomalousTraceIds - Set of traceIds from anomalous spans
 * @returns Scored logs (one per bodyHash group), sorted by score descending
 */
export function scoreLogs(
  logs: TelemetryLog[],
  detectTimeMs: number,
  anomalousTraceIds: Set<string>,
): ScoredLog[] {
  if (logs.length === 0) return []

  // Step 1: Group by bodyHash and select representative
  const groups = new Map<string, { representative: TelemetryLog; count: number }>()

  for (const log of logs) {
    const existing = groups.get(log.bodyHash)
    if (!existing) {
      groups.set(log.bodyHash, { representative: log, count: 1 })
    } else {
      existing.count++
      // Prefer higher severity, then earlier timestamp
      const existingSev = severityRank(existing.representative.severity)
      const newSev = severityRank(log.severity)
      if (newSev > existingSev || (newSev === existingSev && log.startTimeMs < existing.representative.startTimeMs)) {
        existing.representative = log
      }
    }
  }

  // Step 2: Score each group
  const scored: ScoredLog[] = []

  for (const { representative, count } of groups.values()) {
    const severityWeight = LOG_SEVERITY_WEIGHTS[representative.severity.toUpperCase()] ?? 0
    const temporalProximity = Math.exp(
      -TEMPORAL_LAMBDA * Math.abs(representative.startTimeMs - detectTimeMs) / 1000,
    )
    const countFactor = 1 + Math.log2(count)

    const baseScore = severityWeight * temporalProximity * countFactor

    const traceBonus =
      representative.traceId && anomalousTraceIds.has(representative.traceId)
        ? TRACE_CORRELATION_BONUS
        : 0

    const keywordBonus = hasKeywordMatch(representative.body) ? KEYWORD_BONUS : 0

    const score = baseScore + traceBonus + keywordBonus

    scored.push({
      ...representative,
      score,
      groupCount: count,
    })
  }

  // Sort by score descending, tie-break by timestamp ascending for determinism
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.startTimeMs - b.startTimeMs
  })

  return scored
}
