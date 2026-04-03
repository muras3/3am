/**
 * Metrics Surface builder — behavior-grouped metrics for curated evidence.
 *
 * Builds MetricsSurface from raw telemetry metrics by:
 *   1. Querying incident + baseline metrics
 *   2. Scoring with metric-scorer (z-score + class weight + Spearman)
 *   3. Computing per-(service, name) z-scores for anomaly magnitude
 *   4. Grouping into MetricGroup by (service, anomalyMagnitude, metricClass)
 *   5. Building MetricRow with observedValue, expectedValue, deviation, impactBar
 *
 * Pure logic — side effects are limited to TelemetryStoreDriver queries.
 */

import type { TelemetryMetric, TelemetryStoreDriver } from '../telemetry/interface.js'
import { buildIncidentQueryFilter } from '../telemetry/interface.js'
import type { TelemetryScope, AnomalousSignal } from '../storage/interface.js'
import type {
  CuratedMetricsSurface,
  MetricGroup,
  MetricRow,
  MetricGroupKey,
  CuratedEvidenceRef,
} from '@3am/core/schemas/curated-evidence'
import { extractMetricValue, classifyMetric, scoreMetrics } from '../telemetry/scoring/metric-scorer.js'
import { BASELINE_MULTIPLIER } from '../telemetry/constants.js'

// ── Constants ────────────────────────────────────────────────────────────

const MIN_BASELINE_WINDOW_MS = 300_000 // 5 minutes
const MAX_METRIC_ROWS = 20

/** Magnitude sort order (lower = higher priority). */
const MAGNITUDE_ORDER: Record<string, number> = {
  extreme: 0,
  significant: 1,
  moderate: 2,
  baseline: 3,
}

/** Metric class sort order within same magnitude (lower = higher priority). */
const CLASS_ORDER: Record<string, number> = {
  error_rate: 0,
  latency: 1,
  throughput: 2,
  resource: 3,
}

// ── Internal Types ───────────────────────────────────────────────────────

interface MetricStats {
  incidentMean: number
  baselineMean: number | null
  zScore: number | null
  magnitude: MetricGroupKey['anomalyMagnitude']
}

// ── Pure Helpers ─────────────────────────────────────────────────────────

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
 * Classify anomaly magnitude from z-score.
 */
function classifyMagnitude(zScore: number | null): MetricGroupKey['anomalyMagnitude'] {
  if (zScore === null) return 'baseline'
  const abs = Math.abs(zScore)
  if (abs > 3) return 'extreme'
  if (abs > 2) return 'significant'
  if (abs > 1) return 'moderate'
  return 'baseline'
}

/**
 * Map classifyMetric output to MetricGroupKey['metricClass'].
 * "unclassified" maps to "resource" for grouping.
 */
function normalizeMetricClass(
  raw: ReturnType<typeof classifyMetric>,
): MetricGroupKey['metricClass'] {
  return raw === 'unclassified' ? 'resource' : raw
}

/**
 * Build a composite group key string for map operations.
 */
function groupKeyString(key: MetricGroupKey): string {
  return `${key.service}|${key.anomalyMagnitude}|${key.metricClass}`
}

/**
 * Compute per-(service, name) statistics: z-score, mean, magnitude.
 */
function computeMetricStats(
  incidentMetrics: TelemetryMetric[],
  baselineMetrics: TelemetryMetric[],
): Map<string, MetricStats> {
  const stats = new Map<string, MetricStats>()

  // Group incident metrics by (service, name)
  const incidentGroups = new Map<string, TelemetryMetric[]>()
  for (const m of incidentMetrics) {
    const key = `${m.service}|${m.name}`
    const group = incidentGroups.get(key)
    if (group) group.push(m)
    else incidentGroups.set(key, [m])
  }

  // Group baseline metrics by (service, name)
  const baselineGroups = new Map<string, TelemetryMetric[]>()
  for (const m of baselineMetrics) {
    const key = `${m.service}|${m.name}`
    const group = baselineGroups.get(key)
    if (group) group.push(m)
    else baselineGroups.set(key, [m])
  }

  for (const [key, group] of incidentGroups) {
    const incidentValues = group
      .map(m => extractMetricValue(m.summary))
      .filter((v): v is number => v !== null)

    if (incidentValues.length === 0) continue

    const baselineGroup = baselineGroups.get(key) ?? []
    const baselineValues = baselineGroup
      .map(m => extractMetricValue(m.summary))
      .filter((v): v is number => v !== null)

    const incidentMean = mean(incidentValues)

    if (baselineValues.length < 2) {
      // Insufficient baseline — can't compute z-score
      stats.set(key, {
        incidentMean,
        baselineMean: baselineValues.length > 0 ? mean(baselineValues) : null,
        zScore: null,
        magnitude: 'baseline',
      })
      continue
    }

    const baselineMeanVal = mean(baselineValues)
    const baselineStddevVal = stddev(baselineValues)

    if (baselineStddevVal === 0) {
      // Zero variance — z-score undefined
      stats.set(key, {
        incidentMean,
        baselineMean: baselineMeanVal,
        zScore: null,
        magnitude: 'baseline',
      })
      continue
    }

    const zScore = (incidentMean - baselineMeanVal) / baselineStddevVal
    stats.set(key, {
      incidentMean,
      baselineMean: baselineMeanVal,
      zScore,
      magnitude: classifyMagnitude(zScore),
    })
  }

  return stats
}

// ── Main Entry ───────────────────────────────────────────────────────────

export async function buildMetricsSurface(
  telemetryStore: TelemetryStoreDriver,
  telemetryScope: TelemetryScope,
  anomalousSignals: AnomalousSignal[],
): Promise<{ surface: CuratedMetricsSurface; evidenceRefs: Map<string, CuratedEvidenceRef> }> {
  // 1. Query incident metrics
  const incidentFilter = buildIncidentQueryFilter(telemetryScope)
  const incidentMetrics = await telemetryStore.queryMetrics(incidentFilter)

  if (incidentMetrics.length === 0) {
    return {
      surface: { groups: [] },
      evidenceRefs: new Map(),
    }
  }

  // 2. Query baseline metrics
  const incidentDuration = telemetryScope.windowEndMs - telemetryScope.windowStartMs
  const baselineEndMs = telemetryScope.windowStartMs - 1
  const baselineStartMs = baselineEndMs - Math.max(
    incidentDuration * BASELINE_MULTIPLIER,
    MIN_BASELINE_WINDOW_MS,
  )
  const baselineFilter = {
    startMs: baselineStartMs,
    endMs: baselineEndMs,
    services: incidentFilter.services,
    environment: incidentFilter.environment,
  }
  const baselineMetrics = await telemetryStore.queryMetrics(baselineFilter)

  // 3. Score metrics using existing scorer
  const incidentWindow = {
    startMs: telemetryScope.windowStartMs,
    endMs: telemetryScope.windowEndMs,
  }
  const scoredMetrics = scoreMetrics(
    incidentMetrics,
    baselineMetrics,
    anomalousSignals,
    incidentWindow,
  )

  // 4. Compute per-(service, name) z-scores & stats
  const metricStats = computeMetricStats(incidentMetrics, baselineMetrics)

  // 5. Build MetricRows from scored metrics (already sorted by score desc)
  const rows: Array<{ row: MetricRow; groupKey: MetricGroupKey; score: number }> = []

  for (const scored of scoredMetrics) {
    const statKey = `${scored.service}|${scored.name}`
    const stats = metricStats.get(statKey)
    if (!stats) continue

    const observedValue = extractMetricValue(scored.summary)
    if (observedValue === null) continue

    const expectedValue: number | string =
      stats.baselineMean !== null ? stats.baselineMean : 'N/A'

    const deviation: number | null =
      typeof expectedValue === 'number' && expectedValue !== 0
        ? (observedValue - expectedValue) / expectedValue
        : null

    const zScore = stats.zScore

    // impactBar: normalized 0-1. Use zScore if available, else use score from ScoredMetric
    const impactBar =
      zScore !== null
        ? Math.min(1, Math.abs(zScore) / 5)
        : Math.min(1, scored.score / 10)

    const metricClass = normalizeMetricClass(classifyMetric(scored.name))

    const row: MetricRow = {
      refId: `${scored.service}:${scored.name}:${scored.startTimeMs}`,
      name: scored.name,
      service: scored.service,
      observedValue,
      expectedValue,
      deviation,
      zScore,
      impactBar,
    }

    const groupKey: MetricGroupKey = {
      service: scored.service,
      anomalyMagnitude: stats.magnitude,
      metricClass,
    }

    rows.push({ row, groupKey, score: scored.score })
  }

  // 6. Limit to MAX_METRIC_ROWS (already in score order)
  const limitedRows = rows.slice(0, MAX_METRIC_ROWS)

  // 7. Group into MetricGroups
  const groupMap = new Map<string, { key: MetricGroupKey; rows: MetricRow[] }>()

  for (const { row, groupKey } of limitedRows) {
    const keyStr = groupKeyString(groupKey)
    const existing = groupMap.get(keyStr)
    if (existing) {
      existing.rows.push(row)
    } else {
      groupMap.set(keyStr, { key: groupKey, rows: [row] })
    }
  }

  // 8. Build and sort groups: extreme first, then significant, moderate, baseline.
  //    Within same magnitude: error_rate > latency > throughput > resource.
  const groups: MetricGroup[] = []
  let groupIndex = 0

  const sortedEntries = [...groupMap.values()].sort((a, b) => {
    const magDiff =
      (MAGNITUDE_ORDER[a.key.anomalyMagnitude] ?? 3) -
      (MAGNITUDE_ORDER[b.key.anomalyMagnitude] ?? 3)
    if (magDiff !== 0) return magDiff
    return (CLASS_ORDER[a.key.metricClass] ?? 3) - (CLASS_ORDER[b.key.metricClass] ?? 3)
  })

  for (const entry of sortedEntries) {
    groups.push({
      groupId: `mgroup:${groupIndex}`,
      groupKey: entry.key,
      rows: entry.rows,
    })
    groupIndex++
  }

  // 9. Build evidenceRefs
  const evidenceRefs = new Map<string, CuratedEvidenceRef>()
  for (const group of groups) {
    for (const row of group.rows) {
      evidenceRefs.set(row.refId, {
        refId: row.refId,
        surface: 'metrics',
        groupId: group.groupId,
      })
    }
  }

  return {
    surface: { groups },
    evidenceRefs,
  }
}
