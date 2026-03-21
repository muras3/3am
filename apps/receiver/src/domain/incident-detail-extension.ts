/**
 * incident-detail-extension.ts — builds IncidentDetailExtension for GET /api/incidents/:id.
 *
 * Aggregates impact summary, blast radius, confidence primitives, evidence summary,
 * and readiness state from incident data and TelemetryStore queries.
 *
 * Pure computation over incident fields and TelemetryStore query results — no side
 * effects beyond queries.
 */

import type { TelemetryStoreDriver } from '../telemetry/interface.js'
import { buildIncidentQueryFilter } from '../telemetry/interface.js'
import type { Incident, TelemetryScope } from '../storage/interface.js'
import type { IncidentDetailExtension } from '@3amoncall/core'
import { computeBlastRadius } from './blast-radius.js'
import { computeConfidencePrimitives } from './confidence-primitives.js'
import { BASELINE_MULTIPLIER } from '../telemetry/constants.js'

// ── Constants ─────────────────────────────────────────────────────────────

/** Minimum baseline window duration (5 minutes). */
const MIN_BASELINE_WINDOW_MS = 5 * 60 * 1000

/** Minimum baseline spans to classify as "ready". */
const BASELINE_READY_THRESHOLD = 20

// ── Evidence density thresholds ──────────────────────────────────────────

const RICH_TRACE_THRESHOLD = 5
const RICH_METRIC_THRESHOLD = 3
const RICH_LOG_THRESHOLD = 10

// ── Public API ────────────────────────────────────────────────────────────

export async function buildIncidentDetailExtension(
  incident: Incident,
  telemetryStore: TelemetryStoreDriver,
): Promise<IncidentDetailExtension> {
  const { telemetryScope } = incident
  const incidentFilter = buildIncidentQueryFilter(telemetryScope)

  // ── Parallel queries ────────────────────────────────────────────────────
  const [
    { entries: blastRadius, rollup: blastRadiusRollup },
    snapshots,
    spans,
    metrics,
    logs,
    baselineSpans,
  ] = await Promise.all([
    computeBlastRadius(telemetryStore, telemetryScope),
    telemetryStore.getSnapshots(incident.incidentId),
    telemetryStore.querySpans(incidentFilter),
    telemetryStore.queryMetrics(incidentFilter),
    telemetryStore.queryLogs(incidentFilter),
    telemetryStore.querySpans(buildBaselineFilter(telemetryScope)),
  ])

  // ── Confidence primitives ───────────────────────────────────────────────
  const confidencePrimitives = await computeConfidencePrimitives(
    telemetryStore,
    telemetryScope,
    incident.anomalousSignals,
    snapshots,
  )

  // ── Impact summary ─────────────────────────────────────────────────────
  const impactSummary = buildImpactSummary(incident)

  // ── Evidence summary ───────────────────────────────────────────────────
  const traceIds = new Set(spans.map(s => s.traceId))
  const traceErrors = spans.filter(s =>
    (s.httpStatusCode !== undefined && s.httpStatusCode >= 500) ||
    s.spanStatusCode === 2 ||
    s.exceptionCount > 0,
  ).length

  const logErrors = logs.filter(l =>
    l.severity === 'ERROR' || l.severity === 'FATAL',
  ).length

  const evidenceSummary = {
    traces: traceIds.size,
    traceErrors,
    metrics: metrics.length,
    metricsAnomalous: metrics.length, // Phase 1: all incident-window metrics are potentially anomalous
    logs: logs.length,
    logErrors,
  }

  // ── State ──────────────────────────────────────────────────────────────
  const state = {
    diagnosis: classifyDiagnosisState(incident),
    baseline: classifyBaselineState(baselineSpans.length),
    evidenceDensity: classifyEvidenceDensity(
      traceIds.size,
      metrics.length,
      logs.length,
    ),
  }

  return {
    impactSummary,
    blastRadius,
    blastRadiusRollup,
    confidencePrimitives,
    evidenceSummary,
    state,
  }
}

// ── Impact summary ──────────────────────────────────────────────────────

function buildImpactSummary(incident: Incident): IncidentDetailExtension['impactSummary'] {
  const primaryService = incident.packet.scope.primaryService
  const anomalousSignals = incident.anomalousSignals

  // Find first cross-service anomalous signal (entity differs from primary service)
  const crossServiceSignal = anomalousSignals.find(s => s.entity !== primaryService)

  return {
    startedAt: incident.packet.window.start,
    fullCascadeAt: crossServiceSignal?.firstSeenAt,
    diagnosedAt: incident.diagnosisResult?.metadata.created_at,
  }
}

// ── Baseline filter ──────────────────────────────────────────────────────

/**
 * Build a query filter for baseline spans.
 *
 * Baseline window: 4x incident duration, ending at incident start.
 * Minimum 5 minutes. Only queries the primary service.
 */
function buildBaselineFilter(scope: TelemetryScope): import('../telemetry/interface.js').TelemetryQueryFilter {
  const incidentDuration = scope.windowEndMs - scope.windowStartMs
  const baselineWindowMs = Math.max(
    incidentDuration * BASELINE_MULTIPLIER,
    MIN_BASELINE_WINDOW_MS,
  )

  // Use all member services for baseline query
  const services = scope.memberServices.length > 0
    ? [...scope.memberServices]
    : undefined

  return {
    startMs: scope.windowStartMs - baselineWindowMs,
    endMs: scope.windowStartMs - 1,
    services,
    environment: scope.environment,
  }
}

// ── State classifiers ────────────────────────────────────────────────────

function classifyDiagnosisState(
  incident: Incident,
): 'ready' | 'pending' | 'unavailable' {
  if (incident.diagnosisResult) return 'ready'
  if (incident.diagnosisDispatchedAt) return 'pending'
  return 'unavailable'
}

function classifyBaselineState(
  baselineSampleCount: number,
): 'ready' | 'insufficient' | 'unavailable' {
  if (baselineSampleCount >= BASELINE_READY_THRESHOLD) return 'ready'
  if (baselineSampleCount >= 1) return 'insufficient'
  return 'unavailable'
}

function classifyEvidenceDensity(
  traces: number,
  metrics: number,
  logs: number,
): 'rich' | 'sparse' | 'empty' {
  if (
    traces > RICH_TRACE_THRESHOLD &&
    metrics > RICH_METRIC_THRESHOLD &&
    logs > RICH_LOG_THRESHOLD
  ) {
    return 'rich'
  }
  if (traces > 0 || metrics > 0 || logs > 0) return 'sparse'
  return 'empty'
}
