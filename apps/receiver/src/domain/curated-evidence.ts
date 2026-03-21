/**
 * curated-evidence.ts — Orchestrator for GET /api/incidents/:id/evidence.
 *
 * Runs all 3 surface builders in parallel, keeps the deterministic internal
 * surfaces in the receiver, and projects the public console contract from them.
 */

import type { TelemetryStoreDriver } from '../telemetry/interface.js'
import { buildIncidentQueryFilter } from '../telemetry/interface.js'
import type { Incident } from '../storage/interface.js'
import type {
  EvidenceResponse,
  EvidenceIndex,
  CuratedTraceSurface,
  CuratedMetricsSurface,
  CuratedLogsSurface,
  EvidenceRef,
  QABlock,
  SideNote,
  ConsoleNarrative,
} from '@3amoncall/core'
import { buildTraceSurface } from './trace-surface.js'
import { buildMetricsSurface } from './metrics-surface.js'
import { buildLogsSurface } from './logs-surface.js'

export async function buildCuratedEvidence(
  incident: Incident,
  telemetryStore: TelemetryStoreDriver,
): Promise<EvidenceResponse> {
  const incidentFilter = buildIncidentQueryFilter(incident.telemetryScope)

  const [traceResult, metricsResult, logsResult, rawSpans, rawMetrics, rawLogs] = await Promise.all([
    buildTraceSurface(incident, telemetryStore),
    buildMetricsSurface(
      telemetryStore,
      incident.telemetryScope,
      incident.anomalousSignals,
    ),
    buildLogsSurface(
      telemetryStore,
      incident.telemetryScope,
      incident.anomalousSignals,
      incident.spanMembership,
    ),
    // Canonical counts — same query source as incident-detail-extension.ts
    telemetryStore.querySpans(incidentFilter),
    telemetryStore.queryMetrics(incidentFilter),
    telemetryStore.queryLogs(incidentFilter),
  ])

  const evidenceIndex: EvidenceIndex = {
    spans: {},
    metrics: {},
    logs: {},
    absences: {},
  }

  for (const [refId, ref] of traceResult.evidenceRefs) {
    evidenceIndex.spans[refId] = ref
  }

  for (const [refId, ref] of metricsResult.evidenceRefs) {
    evidenceIndex.metrics[refId] = ref
  }

  for (const [refId, ref] of logsResult.evidenceRefs) {
    if (ref.surface === 'absences') {
      evidenceIndex.absences[refId] = ref
    } else {
      evidenceIndex.logs[refId] = ref
    }
  }

  const diagnosis: EvidenceResponse['state']['diagnosis'] =
    incident.diagnosisResult
      ? 'ready'
      : incident.diagnosisDispatchedAt
        ? 'pending'
        : 'unavailable'

  const baselineConfidence = traceResult.surface.baseline.confidence
  const baseline: EvidenceResponse['state']['baseline'] =
    baselineConfidence === 'high' || baselineConfidence === 'medium'
      ? 'ready'
      : baselineConfidence === 'low'
        ? 'insufficient'
        : 'unavailable'

  // Canonical counts: unique traceId, raw metric rows, raw log entries
  // Must match ExtendedIncident.evidenceSummary (incident-detail-extension.ts)
  const traceCount = new Set(rawSpans.map(s => s.traceId)).size
  const metricCount = rawMetrics.length
  const logCount = rawLogs.length
  const evidenceDensity: EvidenceResponse['state']['evidenceDensity'] =
    traceCount > 5 && metricCount > 3 && logCount > 10
      ? 'rich'
      : traceCount > 0 || metricCount > 0 || logCount > 0
        ? 'sparse'
        : 'empty'

  const narrative = incident.consoleNarrative

  return {
    proofCards: [],
    qa: buildQaBlock(narrative?.qa),
    surfaces: {
      traces: toPublicTraceSurface(traceResult.surface),
      metrics: toPublicMetricsSurface(metricsResult.surface),
      logs: toPublicLogsSurface(logsResult.surface),
    },
    sideNotes: buildSideNotes(narrative?.sideNotes),
    state: { diagnosis, baseline, evidenceDensity },
  }
}

function toPublicTraceSurface(surface: CuratedTraceSurface): EvidenceResponse['surfaces']['traces'] {
  return {
    observed: surface.observed.map((trace) => ({
      traceId: trace.traceId,
      route: trace.rootSpanName,
      status: trace.httpStatusCode ?? (trace.status === 'error' ? 500 : 200),
      durationMs: trace.durationMs,
      spans: trace.spans.map((span) => ({
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        name: span.spanName,
        durationMs: span.durationMs,
        status: span.status,
        attributes: span.attributes,
      })),
    })),
    expected: surface.expected.map((trace) => ({
      traceId: trace.traceId,
      route: trace.rootSpanName,
      status: trace.httpStatusCode ?? 200,
      durationMs: trace.durationMs,
      spans: trace.spans.map((span) => ({
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        name: span.spanName,
        durationMs: span.durationMs,
        status: span.status,
        attributes: span.attributes,
      })),
    })),
    smokingGunSpanId: surface.smokingGunSpanId ?? null,
  }
}

function toPublicMetricsSurface(surface: CuratedMetricsSurface): EvidenceResponse['surfaces']['metrics'] {
  return {
    hypotheses: surface.groups.map((group) => ({
      id: group.groupId,
      type: mapClaimType(group.groupKey.metricClass),
      claim: group.diagnosisLabel ?? `${group.groupKey.service} ${group.groupKey.metricClass}`,
      verdict: group.diagnosisVerdict === 'Confirmed' ? 'Confirmed' : 'Inferred',
      metrics: group.rows.map((row) => ({
        name: row.name,
        value: String(row.observedValue),
        expected: String(row.expectedValue),
        barPercent: Math.round(row.impactBar * 100),
      })),
    })),
  }
}

function toPublicLogsSurface(surface: CuratedLogsSurface): EvidenceResponse['surfaces']['logs'] {
  return {
    claims: [
      ...surface.clusters.map((cluster) => ({
        id: cluster.clusterId,
        type: mapClaimType(cluster.clusterKey.keywordHits.join(',')),
        label: cluster.diagnosisLabel ?? `${cluster.clusterKey.primaryService} ${cluster.clusterKey.severityDominant.toLowerCase()} logs`,
        count: cluster.entries.length,
        entries: cluster.entries.map((entry) => ({
          timestamp: entry.timestamp,
          severity: mapLogSeverity(entry.severity),
          body: entry.body,
          signal: entry.isSignal,
        })),
      })),
      ...surface.absenceEvidence.map((absence) => ({
        id: absence.patternId,
        type: 'absence' as const,
        label: absence.diagnosisLabel ?? absence.defaultLabel,
        expected: absence.diagnosisExpected,
        observed: absence.diagnosisExplanation ? 'none observed' : undefined,
        explanation: absence.diagnosisExplanation,
        count: 0,
        entries: [],
      })),
    ],
  }
}

function buildQaBlock(qa: ConsoleNarrative['qa'] | undefined): QABlock | null {
  if (!qa) return null

  return {
    question: qa.question,
    answer: qa.answer,
    evidenceRefs: qa.answerEvidenceRefs,
    evidenceSummary: summarizeEvidenceRefs(qa.answerEvidenceRefs),
    followups: qa.followups,
    ...(qa.noAnswerReason ? { noAnswerReason: qa.noAnswerReason } : {}),
  }
}

function buildSideNotes(notes: ConsoleNarrative['sideNotes'] | undefined): SideNote[] {
  if (!notes) return []
  return notes.map((note) => ({
    title: note.title,
    text: note.text,
    kind: note.kind,
  }))
}

function summarizeEvidenceRefs(refs: EvidenceRef[]): QABlock['evidenceSummary'] {
  const summary = { traces: 0, metrics: 0, logs: 0 }

  for (const ref of refs) {
    if (ref.kind === 'span') summary.traces += 1
    if (ref.kind === 'metric' || ref.kind === 'metric_group') summary.metrics += 1
    if (ref.kind === 'log' || ref.kind === 'log_cluster') summary.logs += 1
  }

  return summary
}

function mapClaimType(metricClassOrKeyword: string): 'trigger' | 'cascade' | 'recovery' | 'absence' {
  if (metricClassOrKeyword.includes('error') || metricClassOrKeyword.includes('rate')) {
    return 'trigger'
  }
  if (metricClassOrKeyword.includes('latency') || metricClassOrKeyword.includes('timeout')) {
    return 'cascade'
  }
  if (metricClassOrKeyword.includes('absence')) {
    return 'absence'
  }
  return 'recovery'
}

function mapLogSeverity(severity: string): 'error' | 'warn' | 'info' {
  const upper = severity.toUpperCase()
  if (upper === 'ERROR' || upper === 'FATAL') return 'error'
  if (upper === 'WARN') return 'warn'
  return 'info'
}
