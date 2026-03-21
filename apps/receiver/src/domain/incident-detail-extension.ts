/**
 * incident-detail-extension.ts — builds IncidentDetailExtension for GET /api/incidents/:id.
 *
 * Aggregates impact summary, blast radius, confidence primitives, evidence summary,
 * and readiness state from incident data and TelemetryStore queries.
 *
 * Pure computation over incident fields and TelemetryStore query results — no side
 * effects beyond queries.
 */

import type { TelemetryStoreDriver, TelemetryQueryFilter } from '../telemetry/interface.js'
import { buildIncidentQueryFilter } from '../telemetry/interface.js'
import type { Incident, TelemetryScope } from '../storage/interface.js'
import type { IncidentDetailExtension, ExtendedIncident } from '@3amoncall/core'
import { computeBlastRadius } from './blast-radius.js'
import { computeConfidencePrimitives } from './confidence-primitives.js'
import { computeEvidenceCounts } from './evidence-counts.js'
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
  const counts = computeEvidenceCounts(spans, logs)

  const evidenceSummary = {
    traces: counts.traceIds,
    traceErrors: counts.traceErrors,
    metrics: metrics.length,
    metricsAnomalous: metrics.length, // Phase 1: all incident-window metrics are potentially anomalous
    logs: logs.length,
    logErrors: counts.logErrors,
  }

  // ── State ──────────────────────────────────────────────────────────────
  const state = {
    diagnosis: classifyDiagnosisState(incident),
    baseline: classifyBaselineState(baselineSpans.length),
    evidenceDensity: classifyEvidenceDensity(
      counts.traceIds,
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

export async function buildExtendedIncident(
  incident: Incident,
  telemetryStore: TelemetryStoreDriver,
): Promise<ExtendedIncident> {
  const extension = await buildIncidentDetailExtension(incident, telemetryStore)
  const diagnosis = incident.diagnosisResult
  const severity = incident.packet.signalSeverity ?? 'medium'
  const confidence = inferConfidenceLabelAndValue(
    diagnosis?.confidence.confidence_assessment ?? 'medium confidence',
  )
  const basis =
    extension.confidencePrimitives.correlations[0] !== undefined
      ? `${extension.confidencePrimitives.correlations[0].metricName} on ${extension.confidencePrimitives.correlations[0].service} correlates ${extension.confidencePrimitives.correlations[0].correlationValue.toFixed(2)}`
      : diagnosis?.confidence.confidence_assessment ?? ''

  const chips: ExtendedIncident['chips'] = []
  const topBlast = extension.blastRadius[0]
  if (topBlast) {
    chips.push({ type: 'critical', label: topBlast.displayValue })
  }
  const firstSignal = incident.anomalousSignals[0]
  if (firstSignal) {
    chips.push({
      type: firstSignal.signal.includes('429') ? 'external' : 'system',
      label: firstSignal.signal,
    })
  }
  const firstDependency = incident.packet.scope.affectedDependencies[0]
  if (firstDependency) {
    chips.push({ type: 'system', label: firstDependency })
  }

  const blastRadius: ExtendedIncident['blastRadius'] = extension.blastRadius.map((entry) => ({
    target: entry.label,
    status: entry.status,
    impactValue: entry.impactValue,
    label: entry.displayValue,
  }))
  if (extension.blastRadiusRollup.healthyCount > 0) {
    blastRadius.push({
      target: extension.blastRadiusRollup.label,
      status: 'healthy',
      impactValue: 0,
      label: 'ok',
    })
  }

  return {
    incidentId: incident.incidentId,
    status: incident.status,
    severity,
    openedAt: incident.openedAt,
    closedAt: incident.closedAt,
    headline: diagnosis?.summary.what_happened ?? '',
    chips,
    action: {
      text: diagnosis?.recommendation.immediate_action ?? '',
      rationale: diagnosis?.recommendation.action_rationale_short ?? '',
      doNot: diagnosis?.recommendation.do_not ?? '',
    },
    rootCauseHypothesis: diagnosis?.summary.root_cause_hypothesis ?? '',
    causalChain: diagnosis?.reasoning.causal_chain.map((step) => ({
      type: step.type,
      tag: chainTag(step.type),
      title: step.title,
      detail: step.detail,
    })) ?? [],
    operatorChecks: diagnosis?.operator_guidance.operator_checks ?? [],
    impactSummary: {
      startedAt: extension.impactSummary.startedAt,
      fullCascadeAt: extension.impactSummary.fullCascadeAt ?? '',
      diagnosedAt: extension.impactSummary.diagnosedAt ?? '',
    },
    blastRadius,
    confidenceSummary: {
      label: confidence.label,
      value: confidence.value,
      basis,
      risk: diagnosis?.confidence.uncertainty ?? '',
    },
    evidenceSummary: {
      traces: extension.evidenceSummary.traces,
      traceErrors: extension.evidenceSummary.traceErrors,
      metrics: extension.evidenceSummary.metrics,
      logs: extension.evidenceSummary.logs,
      logErrors: extension.evidenceSummary.logErrors,
    },
    state: extension.state,
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
function buildBaselineFilter(scope: TelemetryScope): TelemetryQueryFilter {
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

function inferConfidenceLabelAndValue(text: string): { label: string; value: number } {
  const lower = text.toLowerCase()
  if (lower.includes('high')) return { label: 'High confidence', value: 0.85 }
  if (lower.includes('medium')) return { label: 'Medium confidence', value: 0.6 }
  if (lower.includes('low')) return { label: 'Low confidence', value: 0.35 }
  return { label: 'Inferred confidence', value: 0.5 }
}

function chainTag(type: string): string {
  switch (type) {
    case 'external':
      return 'External Trigger'
    case 'system':
      return 'Design Gap'
    case 'incident':
      return 'Cascade'
    case 'impact':
      return 'User Impact'
    default:
      return 'Observation'
  }
}
