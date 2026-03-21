/**
 * confidence-primitives.ts — evidence coverage, correlations, and baseline confidence.
 *
 * Computes ConfidencePrimitives for the incident detail extension.
 * Uses TelemetryStore queries for evidence counts and baseline sampling,
 * and Spearman rank correlation from metric-scorer for temporal correlation.
 *
 * Pure computation over TelemetryStore query results — no side effects beyond queries.
 */

import type { TelemetryStoreDriver, TelemetryQueryFilter, EvidenceSnapshot } from '../telemetry/interface.js'
import { buildIncidentQueryFilter } from '../telemetry/interface.js'
import type { TelemetryScope, AnomalousSignal } from '../storage/interface.js'
import type { ConfidencePrimitives, CorrelationEntry } from '@3amoncall/core'
import { spearmanCorrelation, extractMetricValue } from '../telemetry/scoring/metric-scorer.js'
import { BASELINE_MULTIPLIER } from '../telemetry/constants.js'

// ── Constants ─────────────────────────────────────────────────────────────

/** Minimum baseline window duration (5 minutes). */
const MIN_BASELINE_WINDOW_MS = 5 * 60 * 1000

/** Maximum correlations to include in output. */
const MAX_CORRELATIONS = 10

/** Minimum absolute correlation to include as noteworthy. */
const CORRELATION_THRESHOLD = 0.5

// ── Baseline confidence thresholds ────────────────────────────────────────

const HIGH_BASELINE_THRESHOLD = 30
const MEDIUM_BASELINE_THRESHOLD = 10

// ── Public API ────────────────────────────────────────────────────────────

export async function computeConfidencePrimitives(
  telemetryStore: TelemetryStoreDriver,
  telemetryScope: TelemetryScope,
  anomalousSignals: AnomalousSignal[],
  _snapshots: EvidenceSnapshot[],
): Promise<ConfidencePrimitives> {
  const incidentFilter = buildIncidentQueryFilter(telemetryScope)

  // ── Evidence coverage counts ────────────────────────────────────────────
  const [spans, metrics, logs, baselineSpans] = await Promise.all([
    telemetryStore.querySpans(incidentFilter),
    telemetryStore.queryMetrics(incidentFilter),
    telemetryStore.queryLogs(incidentFilter),
    telemetryStore.querySpans(buildBaselineFilter(telemetryScope)),
  ])

  const traceCount = new Set(spans.map(s => s.traceId)).size
  const metricCount = metrics.length
  const logCount = logs.length
  const baselineSampleCount = baselineSpans.length

  // ── Correlations ────────────────────────────────────────────────────────
  const correlations = computeCorrelations(
    metrics,
    anomalousSignals,
    telemetryScope,
  )

  // ── Baseline confidence ─────────────────────────────────────────────────
  const baselineConfidence = classifyBaselineConfidence(baselineSampleCount)

  return {
    evidenceCoverage: {
      traceCount,
      metricCount,
      logCount,
      baselineSampleCount,
    },
    correlations,
    baselineConfidence,
  }
}

// ── Baseline filter ───────────────────────────────────────────────────────

/**
 * Build a query filter for the baseline window.
 *
 * Baseline window: 4x incident duration, ending at incident start.
 * Minimum 5 minutes.
 */
function buildBaselineFilter(scope: TelemetryScope): TelemetryQueryFilter {
  const incidentDuration = scope.windowEndMs - scope.windowStartMs
  const baselineWindowMs = Math.max(
    incidentDuration * BASELINE_MULTIPLIER,
    MIN_BASELINE_WINDOW_MS,
  )

  const queryServices = [...new Set([...scope.memberServices, ...scope.dependencyServices])]

  return {
    startMs: scope.windowStartMs - baselineWindowMs,
    endMs: scope.windowStartMs - 1, // exclusive of incident start
    services: queryServices.length > 0 ? queryServices : undefined,
    environment: scope.environment,
  }
}

// ── Correlation computation ───────────────────────────────────────────────

/**
 * Compute Spearman rank correlations between metric time series and
 * anomalous signal counts, grouped by (service, metricName).
 *
 * Uses time-bucketed arrays for both metric values and signal counts,
 * then applies Spearman correlation from metric-scorer.
 *
 * Returns top 10 correlations with |rho| > 0.5, sorted by |rho| desc.
 */
function computeCorrelations(
  metrics: { service: string; name: string; startTimeMs: number; summary: Record<string, unknown> }[],
  anomalousSignals: AnomalousSignal[],
  scope: TelemetryScope,
): CorrelationEntry[] {
  if (metrics.length === 0 || anomalousSignals.length === 0) return []

  const windowDuration = scope.windowEndMs - scope.windowStartMs
  if (windowDuration <= 0) return []

  // Create time buckets spanning the incident window
  const numBuckets = Math.max(2, Math.min(10, Math.floor(windowDuration / 1000)))
  const bucketWidth = windowDuration / numBuckets
  const bucketStarts = Array.from({ length: numBuckets }, (_, i) => scope.windowStartMs + i * bucketWidth)

  // Build signal distribution once (shared across all metric groups)
  const signalTimestamps = anomalousSignals.map(s => new Date(s.firstSeenAt).getTime())
  const signalDist = buildTemporalDistribution(signalTimestamps, bucketStarts, bucketWidth)

  // Need at least 2 non-zero signal buckets for meaningful correlation
  const signalNonZero = signalDist.filter(v => v > 0).length
  if (signalNonZero < 2) return []

  // Group metrics by (service, name)
  const metricGroups = new Map<string, { service: string; name: string; timestamps: number[]; values: number[] }>()

  for (const m of metrics) {
    const key = `${m.service}|${m.name}`
    const value = extractMetricValue(m.summary)
    if (value === null) continue

    let group = metricGroups.get(key)
    if (!group) {
      group = { service: m.service, name: m.name, timestamps: [], values: [] }
      metricGroups.set(key, group)
    }
    group.timestamps.push(m.startTimeMs)
    group.values.push(value)
  }

  const candidates: CorrelationEntry[] = []

  for (const [, group] of metricGroups) {
    // Build metric value distribution across time buckets
    const metricDist = buildMetricBucketDistribution(
      group.timestamps,
      group.values,
      bucketStarts,
      bucketWidth,
    )

    // Need at least 2 non-zero metric buckets
    const metricNonZero = metricDist.filter(v => v > 0).length
    if (metricNonZero < 2) continue

    const rho = spearmanCorrelation(metricDist, signalDist)
    if (Number.isNaN(rho)) continue
    if (Math.abs(rho) <= CORRELATION_THRESHOLD) continue

    candidates.push({
      metricName: group.name,
      service: group.service,
      correlationValue: rho,
    })
  }

  // Sort by absolute correlation descending, limit to top 10
  candidates.sort((a, b) => Math.abs(b.correlationValue) - Math.abs(a.correlationValue))
  return candidates.slice(0, MAX_CORRELATIONS)
}

// ── Temporal distribution helpers ─────────────────────────────────────────

/**
 * Build a count distribution for timestamps across time buckets.
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

/**
 * Build an average metric value distribution across time buckets.
 * Each bucket gets the average of metric values whose timestamp falls within it.
 * Buckets with no values get 0.
 */
function buildMetricBucketDistribution(
  timestamps: number[],
  values: number[],
  bucketStarts: number[],
  bucketWidth: number,
): number[] {
  const sums = new Array<number>(bucketStarts.length).fill(0)
  const counts = new Array<number>(bucketStarts.length).fill(0)

  for (let idx = 0; idx < timestamps.length; idx++) {
    const ts = timestamps[idx]
    for (let i = 0; i < bucketStarts.length; i++) {
      if (ts >= bucketStarts[i] && ts < bucketStarts[i] + bucketWidth) {
        sums[i] += values[idx]
        counts[i]++
        break
      }
    }
  }

  return sums.map((sum, i) => (counts[i] > 0 ? sum / counts[i] : 0))
}

// ── Baseline confidence classification ────────────────────────────────────

function classifyBaselineConfidence(
  baselineSampleCount: number,
): 'high' | 'medium' | 'low' | 'unavailable' {
  if (baselineSampleCount >= HIGH_BASELINE_THRESHOLD) return 'high'
  if (baselineSampleCount >= MEDIUM_BASELINE_THRESHOLD) return 'medium'
  if (baselineSampleCount >= 1) return 'low'
  return 'unavailable'
}
