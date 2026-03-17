/**
 * metric-scorer.ts — z-score + class weight + Spearman correlation scoring
 *
 * ADR 0032 Decision 5.1: Metrics are scored by statistical anomaly (z-score
 * against baseline), weighted by metric class (error > latency > throughput
 * > resource), with a bonus for temporal correlation with anomalous signals.
 *
 * Pure functions with no side effects or I/O.
 */

import type { TelemetryMetric } from '../interface.js'
import type { AnomalousSignal } from '../../storage/interface.js'
import {
  METRIC_CLASS_WEIGHTS,
  MIN_BASELINE_DATAPOINTS,
  SPEARMAN_BONUS,
} from '../constants.js'

// ---------------------------------------------------------------------------
// Scored type
// ---------------------------------------------------------------------------

export type ScoredMetric = TelemetryMetric & { score: number }

// ---------------------------------------------------------------------------
// Metric value extraction
// ---------------------------------------------------------------------------

/**
 * Extract a representative numeric value from a metric summary object.
 *
 * Handles three OTLP data shapes:
 * - Histogram: { count, sum, min?, max? } → sum / count (average)
 * - Gauge: { asDouble } or { asInt }
 * - Sum: { asDouble } or { asInt }
 *
 * Returns null if no numeric value can be extracted.
 */
export function extractMetricValue(summary: Record<string, unknown>): number | null {
  // Gauge / Sum — asDouble preferred over asInt
  if (typeof summary.asDouble === 'number') return summary.asDouble
  if (typeof summary.asInt === 'number') return summary.asInt

  // Histogram — compute mean from sum / count
  if (typeof summary.sum === 'number' && typeof summary.count === 'number' && summary.count > 0) {
    return summary.sum / summary.count
  }

  return null
}

// ---------------------------------------------------------------------------
// Metric classification
// ---------------------------------------------------------------------------

/**
 * Classify a metric by name pattern into one of the standard categories.
 * Classification determines the weight multiplier for scoring.
 */
export function classifyMetric(
  name: string,
): 'error_rate' | 'latency' | 'throughput' | 'resource' | 'unclassified' {
  const lower = name.toLowerCase()

  // Error-rate patterns (checked first — "error_rate" should not match throughput)
  if (/error|fault|fail|4xx|5xx/.test(lower)) return 'error_rate'

  // Latency patterns
  if (/duration|latency|response_time|p99|p95/.test(lower)) return 'latency'

  // Throughput patterns (NOT error_rate — already matched above)
  if (/count|request|throughput|rate/.test(lower)) return 'throughput'

  // Resource patterns
  if (/memory|cpu|pool|connection|queue|disk/.test(lower)) return 'resource'

  return 'unclassified'
}

// ---------------------------------------------------------------------------
// Spearman rank correlation
// ---------------------------------------------------------------------------

/**
 * Compute Spearman rank correlation coefficient between two paired arrays.
 *
 * Both arrays must have the same length. Returns NaN if length < 2 or
 * if all values in either array are identical (zero variance in ranks).
 *
 * Uses the formula: rho = 1 - (6 * sum(d^2)) / (n * (n^2 - 1))
 * where d = rank(x_i) - rank(y_i) for each paired observation.
 *
 * Handles ties via average rank assignment.
 */
export function spearmanCorrelation(xs: number[], ys: number[]): number {
  const n = xs.length
  if (n < 2 || n !== ys.length) return NaN

  const rankX = computeRanks(xs)
  const rankY = computeRanks(ys)

  let sumD2 = 0
  for (let i = 0; i < n; i++) {
    const d = rankX[i] - rankY[i]
    sumD2 += d * d
  }

  const denom = n * (n * n - 1)
  if (denom === 0) return NaN

  return 1 - (6 * sumD2) / denom
}

/**
 * Compute average ranks for an array of values.
 * Ties receive the average of the positions they span.
 */
function computeRanks(values: number[]): number[] {
  const n = values.length
  // Create index-value pairs and sort by value
  const indexed = values.map((v, i) => ({ value: v, index: i }))
  indexed.sort((a, b) => a.value - b.value)

  const ranks = new Array<number>(n)
  let i = 0
  while (i < n) {
    // Find the extent of the tie group
    let j = i
    while (j < n && indexed[j].value === indexed[i].value) j++
    // Average rank for this tie group (1-based ranks)
    const avgRank = (i + 1 + j) / 2
    for (let k = i; k < j; k++) {
      ranks[indexed[k].index] = avgRank
    }
    i = j
  }

  return ranks
}

// ---------------------------------------------------------------------------
// z-score calculation
// ---------------------------------------------------------------------------

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0
  const m = mean(values)
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

/**
 * Compute z-score, with fallback to volume heuristic when baseline
 * data is insufficient (< MIN_BASELINE_DATAPOINTS datapoints).
 *
 * Volume heuristic: percentage change from baseline mean, capped at 10.
 * Prevents extreme scores when baseline is sparse.
 */
function computeZScore(
  incidentValues: number[],
  baselineValues: number[],
): number {
  if (incidentValues.length === 0) return 0

  const incidentMean = mean(incidentValues)
  const baselineMean = mean(baselineValues)
  const baselineStddev = stddev(baselineValues)

  // Insufficient baseline data or zero stddev → volume heuristic
  if (baselineValues.length < MIN_BASELINE_DATAPOINTS || baselineStddev === 0) {
    if (baselineMean === 0) {
      // No baseline reference — can't compute meaningful score
      return incidentMean === 0 ? 0 : Math.min(10, Math.abs(incidentMean))
    }
    const pctChange = Math.abs((incidentMean - baselineMean) / baselineMean)
    return Math.min(10, pctChange)
  }

  return (incidentMean - baselineMean) / baselineStddev
}

// ---------------------------------------------------------------------------
// Spearman bonus calculation
// ---------------------------------------------------------------------------

/**
 * Build a temporal indicator array for a set of timestamps aligned to
 * a common set of time buckets. Each bucket gets the count of events
 * within it.
 */
function buildTemporalDistribution(
  timestamps: number[],
  bucketStarts: number[],
  bucketWidth: number,
): number[] {
  const counts = new Array<number>(bucketStarts.length).fill(0)
  for (const ts of timestamps) {
    for (let i = 0; i < bucketStarts.length; i++) {
      if (ts >= bucketStarts[i] && ts < bucketStarts[i] + bucketWidth) {
        counts[i]++
        break
      }
    }
  }
  return counts
}

function computeSpearmanBonus(
  metricTimestamps: number[],
  anomalousSignals: AnomalousSignal[],
  incidentWindowStartMs: number,
  incidentWindowEndMs: number,
): number {
  // Need enough datapoints for meaningful correlation
  if (metricTimestamps.length < 5 || anomalousSignals.length === 0) return 0

  const signalTimestamps = anomalousSignals.map(s => new Date(s.firstSeenAt).getTime())

  // Create time buckets spanning the incident window
  const windowDuration = incidentWindowEndMs - incidentWindowStartMs
  if (windowDuration <= 0) return 0

  // Use ~10 buckets or fewer if window is short
  const numBuckets = Math.max(2, Math.min(10, Math.floor(windowDuration / 1000)))
  const bucketWidth = windowDuration / numBuckets
  const bucketStarts = Array.from({ length: numBuckets }, (_, i) => incidentWindowStartMs + i * bucketWidth)

  const metricDist = buildTemporalDistribution(metricTimestamps, bucketStarts, bucketWidth)
  const signalDist = buildTemporalDistribution(signalTimestamps, bucketStarts, bucketWidth)

  // Need non-trivial distributions
  const metricNonZero = metricDist.filter(v => v > 0).length
  const signalNonZero = signalDist.filter(v => v > 0).length
  if (metricNonZero < 2 || signalNonZero < 2) return 0

  const rho = spearmanCorrelation(metricDist, signalDist)
  if (Number.isNaN(rho)) return 0

  return Math.abs(rho) > 0.5 ? SPEARMAN_BONUS : 0
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Score incident-window metrics against baseline metrics using z-score,
 * metric class weight, and Spearman temporal correlation with anomalous signals.
 *
 * @param incidentMetrics - Metrics within the incident time window
 * @param baselineMetrics - Metrics from the baseline window (4x incident window)
 * @param anomalousSignals - Anomalous signals detected during the incident
 * @param incidentWindow - { startMs, endMs } of the incident time window
 * @returns Scored metrics sorted by score descending
 */
export function scoreMetrics(
  incidentMetrics: TelemetryMetric[],
  baselineMetrics: TelemetryMetric[],
  anomalousSignals: AnomalousSignal[],
  incidentWindow: { startMs: number; endMs: number },
): ScoredMetric[] {
  if (incidentMetrics.length === 0) return []

  // Group incident metrics by (service, name)
  const incidentGroups = groupMetrics(incidentMetrics)

  // Group baseline metrics by (service, name)
  const baselineGroups = groupMetrics(baselineMetrics)

  const scored: ScoredMetric[] = []

  for (const [groupKey, groupMetrics_] of incidentGroups) {
    // Extract numeric values from each metric in the group
    const incidentValues = groupMetrics_
      .map(m => extractMetricValue(m.summary))
      .filter((v): v is number => v !== null)

    const baselineValues = (baselineGroups.get(groupKey) ?? [])
      .map(m => extractMetricValue(m.summary))
      .filter((v): v is number => v !== null)

    if (incidentValues.length === 0) continue

    // z-score (or volume heuristic fallback)
    const zScore = computeZScore(incidentValues, baselineValues)

    // Class weight
    const sampleMetric = groupMetrics_[0]
    const metricClass = classifyMetric(sampleMetric.name)
    const classWeight = METRIC_CLASS_WEIGHTS[metricClass] ?? 0.5

    // Spearman correlation bonus
    const metricTimestamps = groupMetrics_.map(m => m.startTimeMs)
    const spearmanBonus = computeSpearmanBonus(
      metricTimestamps,
      anomalousSignals,
      incidentWindow.startMs,
      incidentWindow.endMs,
    )

    // Final score
    const score = Math.abs(zScore) * classWeight + spearmanBonus

    // Use the metric with the highest absolute value as representative
    const representative = groupMetrics_.reduce((best, m) => {
      const bestVal = extractMetricValue(best.summary)
      const mVal = extractMetricValue(m.summary)
      if (bestVal === null) return m
      if (mVal === null) return best
      return Math.abs(mVal) > Math.abs(bestVal) ? m : best
    })

    scored.push({ ...representative, score })
  }

  // Sort by score descending, tie-break by metric name for determinism
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.name.localeCompare(b.name)
  })

  return scored
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Group metrics by (service, name) composite key.
 */
function groupMetrics(metrics: TelemetryMetric[]): Map<string, TelemetryMetric[]> {
  const groups = new Map<string, TelemetryMetric[]>()
  for (const m of metrics) {
    const key = `${m.service}|${m.name}`
    const group = groups.get(key)
    if (group) {
      group.push(m)
    } else {
      groups.set(key, [m])
    }
  }
  return groups
}
