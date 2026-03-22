/**
 * curated-evidence.ts — Orchestrator for GET /api/incidents/:id/evidence.
 *
 * Runs all 3 surface builders in parallel, keeps the deterministic internal
 * surfaces in the receiver, and projects the public console contract from them.
 */

import type { TelemetryStoreDriver } from '../telemetry/interface.js'
import type { Incident } from '../storage/interface.js'
import type {
  EvidenceResponse,
  EvidenceIndex,
  CuratedTraceSurface,
  CuratedMetricsSurface,
  CuratedLogsSurface,
  EvidenceRef,
  ProofCard,
  QABlock,
  SideNote,
  ConsoleNarrative,
  ProofCardNarrative,
  ProofRef,
} from '@3amoncall/core'
import { buildTraceSurface } from './trace-surface.js'
import { buildMetricsSurface } from './metrics-surface.js'
import { buildLogsSurface } from './logs-surface.js'
import { buildReasoningStructure } from './reasoning-structure-builder.js'

export async function buildCuratedEvidence(
  incident: Incident,
  telemetryStore: TelemetryStoreDriver,
): Promise<EvidenceResponse> {
  const [traceResult, metricsResult, logsResult, reasoningStructure] = await Promise.all([
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
    buildReasoningStructure(incident, telemetryStore),
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

  // Evidence density uses CURATED counts (what the operator sees in Evidence Studio),
  // not raw telemetry counts. These intentionally differ from
  // ExtendedIncident.evidenceSummary which reports raw ingested counts (unique
  // traceIds, raw metric rows, raw log entries). The two endpoints serve
  // different purposes: evidenceSummary shows data volume, evidenceDensity
  // reflects curated analytical depth. Do NOT require exact-match between them.
  const traceCount = new Set(traceResult.surface.observed.map(t => t.traceId)).size
  const metricCount = metricsResult.surface.groups.reduce(
    (sum, g) => sum + g.rows.length, 0,
  )
  const logCount = logsResult.surface.clusters.reduce(
    (sum, c) => sum + c.entries.length, 0,
  )
  const evidenceDensity: EvidenceResponse['state']['evidenceDensity'] =
    traceCount > 5 && metricCount > 3 && logCount > 10
      ? 'rich'
      : traceCount > 0 || metricCount > 0 || logCount > 0
        ? 'sparse'
        : 'empty'

  const narrative = incident.consoleNarrative

  // A-3: Write back LLM absence labels to the logs surface before public projection
  if (narrative?.absenceEvidence) {
    const labelMap = new Map(narrative.absenceEvidence.map((a) => [a.id, a]))
    for (const absence of logsResult.surface.absenceEvidence) {
      const labels = labelMap.get(absence.patternId)
      if (labels) {
        absence.diagnosisLabel = labels.label
        absence.diagnosisExpected = labels.expected
        absence.diagnosisExplanation = labels.explanation
      }
    }
  }

  return {
    proofCards: buildProofCards(narrative?.proofCards, reasoningStructure.proofRefs),
    qa: buildQaBlock(narrative?.qa),
    surfaces: {
      traces: toPublicTraceSurface(traceResult.surface),
      metrics: toPublicMetricsSurface(metricsResult.surface),
      logs: toPublicLogsSurface(logsResult.surface),
    },
    sideNotes: buildSideNotes(narrative?.sideNotes, incident),
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
    // Internal CuratedTraceSurface stores smokingGunSpanId as "traceId:spanId"
    // but the public TraceSurface spans only have spanId. Extract just the
    // spanId part so the frontend can match it against span rows.
    smokingGunSpanId: extractSpanId(surface.smokingGunSpanId) ?? null,
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
        value: formatMetricValue(row.observedValue),
        expected: formatMetricValue(row.expectedValue),
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

function buildProofCards(
  narrativeCards: ProofCardNarrative[] | undefined,
  proofRefs: ProofRef[],
): ProofCard[] {
  const refMap = new Map(proofRefs.map((r) => [r.cardId, r]))

  // When narrative is available, merge wording (narrative) with evidence (proofRefs)
  if (narrativeCards) {
    return narrativeCards.map((card) => {
      const ref = refMap.get(card.id)
      return {
        id: card.id,
        label: card.label,
        status: ref?.status ?? 'pending',
        summary: card.summary,
        targetSurface: ref?.targetSurface ?? 'traces',
        evidenceRefs: ref?.evidenceRefs ?? [],
      }
    })
  }

  // Deterministic fallback: generate proof cards from proofRefs alone (no LLM wording)
  if (proofRefs.length === 0) return []
  return proofRefs.map((ref) => ({
    id: ref.cardId,
    label: defaultProofCardLabel(ref.cardId),
    status: ref.status,
    summary: '',
    targetSurface: ref.targetSurface,
    evidenceRefs: ref.evidenceRefs,
  }))
}

function defaultProofCardLabel(cardId: string): string {
  switch (cardId) {
    case 'trigger': return 'Trigger Evidence'
    case 'design_gap': return 'Design Gap'
    case 'recovery': return 'Recovery Path'
    default: return cardId
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

function buildSideNotes(
  notes: ConsoleNarrative['sideNotes'] | undefined,
  incident: Incident,
): SideNote[] {
  if (notes && notes.length > 0) {
    return notes.map((note) => ({
      title: note.title,
      text: note.text,
      kind: note.kind,
    }))
  }

  // Deterministic fallback from stage 1 + raw data
  const result: SideNote[] = []
  const diag = incident.diagnosisResult

  if (diag?.confidence.confidence_assessment) {
    result.push({
      title: 'Confidence',
      text: diag.confidence.confidence_assessment,
      kind: 'confidence',
    })
  }
  if (diag?.confidence.uncertainty) {
    result.push({
      title: 'Uncertainty',
      text: diag.confidence.uncertainty,
      kind: 'uncertainty',
    })
  }
  const deps = incident.packet.scope.affectedDependencies
  if (deps.length > 0) {
    result.push({
      title: 'External Dependencies',
      text: deps.join(', '),
      kind: 'dependency',
    })
  }

  return result
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

function formatMetricValue(value: number | string): string {
  if (typeof value === 'string') return value
  if (Number.isInteger(value)) return String(value)
  if (Math.abs(value) >= 100) return value.toFixed(1)
  if (Math.abs(value) >= 1) return value.toFixed(2)
  return value.toPrecision(3)
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

/**
 * Extracts the spanId from a potentially composite "traceId:spanId" format.
 * If the value contains a colon, returns the part after the last colon.
 * If no colon, returns the value as-is.
 */
function extractSpanId(compositeId: string | undefined): string | undefined {
  if (!compositeId) return undefined
  const colonIdx = compositeId.lastIndexOf(':')
  return colonIdx >= 0 ? compositeId.slice(colonIdx + 1) : compositeId
}
