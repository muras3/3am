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
  NarrativeEvidenceCounts,
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
    qa: buildQaBlock(incident, narrative?.qa, reasoningStructure.proofRefs, reasoningStructure.evidenceCounts),
    surfaces: {
      traces: toPublicTraceSurface(traceResult.surface, logsResult.surface),
      metrics: toPublicMetricsSurface(metricsResult.surface),
      logs: toPublicLogsSurface(logsResult.surface),
    },
    sideNotes: buildSideNotes(narrative?.sideNotes, incident),
    state: { diagnosis, baseline, evidenceDensity },
  }
}

function toPublicTraceSurface(
  surface: CuratedTraceSurface,
  logsSurface: CuratedLogsSurface,
): EvidenceResponse['surfaces']['traces'] {
  const logIndex = new Map(
    logsSurface.clusters.flatMap((cluster) =>
      cluster.entries.map((entry) => [entry.refId, entry] as const),
    ),
  )
  const expectedDurationIndex = buildExpectedDurationIndex(surface)

  return {
    observed: surface.observed.map((trace) => ({
      traceId: trace.traceId,
      route: trace.rootSpanName,
      status: trace.httpStatusCode ?? (trace.status === 'error' ? 500 : 200),
      durationMs: trace.durationMs,
      ...(expectedDurationIndex.get(trace.rootSpanName) !== undefined
        ? { expectedDurationMs: expectedDurationIndex.get(trace.rootSpanName) }
        : {}),
      annotation: buildObservedTraceAnnotation(trace.rootSpanName, trace.durationMs, expectedDurationIndex.get(trace.rootSpanName)),
      spans: trace.spans.map((span) => ({
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        name: span.spanName,
        durationMs: span.durationMs,
        status: span.status,
        attributes: span.attributes,
        correlatedLogs: span.correlatedLogRefIds
          .map((refId) => logIndex.get(refId))
          .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
          .map((entry) => ({
            refId: entry.refId,
            timestamp: entry.timestamp,
            severity: mapLogSeverity(entry.severity),
            body: entry.body,
          })),
      })),
    })),
    expected: surface.expected.map((trace) => ({
      traceId: trace.traceId,
      route: trace.rootSpanName,
      status: trace.httpStatusCode ?? 200,
      durationMs: trace.durationMs,
      annotation: buildExpectedTraceAnnotation(surface, trace.rootSpanName, trace.durationMs),
      spans: trace.spans.map((span) => ({
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        name: span.spanName,
        durationMs: span.durationMs,
        status: span.status,
        attributes: span.attributes,
        correlatedLogs: [],
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
    return (['trigger', 'design_gap', 'recovery'] as const).map((cardId) => {
      const ref = refMap.get(cardId)
      const narrativeCard = narrativeCards.find((card) => card.id === cardId)
      return {
        id: cardId,
        label: narrativeCard?.label ?? defaultProofCardLabel(cardId),
        status: ref?.status ?? 'pending',
        summary: narrativeCard?.summary ?? defaultProofCardSummary(cardId, ref),
        targetSurface: ref?.targetSurface ?? defaultProofCardSurface(cardId),
        evidenceRefs: ref?.evidenceRefs ?? [],
      }
    })
  }

  // Deterministic fallback: generate proof cards from proofRefs alone (no LLM wording)
  return (['trigger', 'design_gap', 'recovery'] as const).map((cardId) => {
    const ref = refMap.get(cardId)
    return {
      id: cardId,
      label: defaultProofCardLabel(cardId),
      status: ref?.status ?? 'pending',
      summary: defaultProofCardSummary(cardId, ref),
      targetSurface: ref?.targetSurface ?? defaultProofCardSurface(cardId),
      evidenceRefs: ref?.evidenceRefs ?? [],
    }
  })
}

function defaultProofCardLabel(cardId: string): string {
  switch (cardId) {
    case 'trigger': return 'Trigger Evidence'
    case 'design_gap': return 'Design Gap'
    case 'recovery': return 'Recovery Path'
    default: return cardId
  }
}

function defaultProofCardSurface(cardId: string): ProofCard['targetSurface'] {
  switch (cardId) {
    case 'trigger':
      return 'traces'
    case 'design_gap':
      return 'logs'
    case 'recovery':
      return 'logs'
    default:
      return 'traces'
  }
}

function defaultProofCardSummary(cardId: string, ref: ProofRef | undefined): string {
  const evidenceCount = ref?.evidenceRefs.length ?? 0
  const surface = ref?.targetSurface ?? defaultProofCardSurface(cardId)

  switch (cardId) {
    case 'trigger':
      return evidenceCount > 0
        ? `${evidenceCount} deterministic ${surface} reference(s) capture the trigger path.`
        : 'Trigger evidence is reserved in the contract, but deterministic references are not available yet.'
    case 'design_gap':
      return evidenceCount > 0
        ? `${evidenceCount} deterministic ${surface} reference(s) describe the suspected design gap.`
        : 'Receiver reserved the design-gap card; diagnosis wording is pending and direct evidence is still sparse.'
    case 'recovery':
      return evidenceCount > 0
        ? `${evidenceCount} deterministic ${surface} reference(s) show the recovery path.`
        : 'Recovery evidence is not available yet, but the recovery card remains visible by contract.'
    default:
      return 'Deterministic evidence placeholder.'
  }
}

function buildQaBlock(
  incident: Incident,
  qa: ConsoleNarrative['qa'] | undefined,
  proofRefs: ProofRef[],
  evidenceCounts: NarrativeEvidenceCounts,
): QABlock {
  if (qa) {
    return {
      question: qa.question,
      answer: qa.answer,
      evidenceRefs: qa.answerEvidenceRefs,
      evidenceSummary: summarizeEvidenceRefs(qa.answerEvidenceRefs),
      followups: qa.followups,
      ...(qa.noAnswerReason ? { noAnswerReason: qa.noAnswerReason } : {}),
    }
  }

  const defaultRefs = proofRefs.flatMap((ref) => ref.evidenceRefs).slice(0, 6)
  const primaryRoute = incident.packet.scope.affectedRoutes[0]
  const primaryTarget = primaryRoute ? `${incident.packet.scope.primaryService} ${primaryRoute}` : incident.packet.scope.primaryService
  const diagnosisPending = !incident.diagnosisResult

  return {
    question: `What explains the current incident on ${primaryTarget}?`,
    answer: diagnosisPending
      ? 'Diagnosis wording is not ready yet. Use the deterministic traces, metrics, and logs below to inspect the current evidence.'
      : [
          incident.diagnosisResult?.summary.root_cause_hypothesis,
          incident.diagnosisResult?.recommendation.action_rationale_short,
        ].filter(Boolean).join(' '),
    evidenceRefs: defaultRefs,
    evidenceSummary: {
      traces: evidenceCounts.traces,
      metrics: evidenceCounts.metrics,
      logs: evidenceCounts.logs,
    },
    followups: buildDeterministicFollowups(evidenceCounts),
    ...(diagnosisPending
      ? { noAnswerReason: 'Diagnosis narrative is pending; deterministic evidence surfaces are available now.' }
      : {}),
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

function buildDeterministicFollowups(
  evidenceCounts: NarrativeEvidenceCounts,
): QABlock['followups'] {
  const followups: QABlock['followups'] = []

  if (evidenceCounts.traces > 0) {
    followups.push({
      question: 'Which span is acting as the smoking gun?',
      targetEvidenceKinds: ['traces'],
    })
  }
  if (evidenceCounts.metrics > 0) {
    followups.push({
      question: 'How far did observed metrics diverge from baseline?',
      targetEvidenceKinds: ['metrics'],
    })
  }
  if (evidenceCounts.logs > 0) {
    followups.push({
      question: 'Which logs correlate directly with the failing span?',
      targetEvidenceKinds: ['logs', 'traces'],
    })
  }

  if (followups.length === 0) {
    followups.push({
      question: 'What evidence is still missing for this incident?',
      targetEvidenceKinds: ['traces', 'metrics', 'logs'],
    })
  }

  return followups
}

function buildExpectedDurationIndex(surface: CuratedTraceSurface): Map<string, number> {
  const totals = new Map<string, { durationMs: number; count: number }>()

  for (const trace of surface.expected) {
    const current = totals.get(trace.rootSpanName) ?? { durationMs: 0, count: 0 }
    current.durationMs += trace.durationMs
    current.count += 1
    totals.set(trace.rootSpanName, current)
  }

  return new Map(
    [...totals.entries()].map(([route, value]) => [route, Math.round(value.durationMs / value.count)]),
  )
}

function buildObservedTraceAnnotation(
  route: string,
  durationMs: number,
  expectedDurationMs: number | undefined,
): string {
  if (expectedDurationMs === undefined) {
    return `Observed trace for ${route}. Baseline comparison is not available.`
  }

  const ratio = expectedDurationMs > 0 ? (durationMs / expectedDurationMs).toFixed(1) : 'n/a'
  return `Observed ${durationMs}ms on ${route} versus expected ${expectedDurationMs}ms (${ratio}x slower).`
}

function buildExpectedTraceAnnotation(
  surface: CuratedTraceSurface,
  route: string,
  durationMs: number,
): string {
  const source = surface.baseline.source.kind === 'none'
    ? 'No baseline source'
    : surface.baseline.source.kind === 'same_route'
      ? `Baseline from ${surface.baseline.source.service} ${surface.baseline.source.route}`
      : `Baseline from ${surface.baseline.source.service}`

  return `${source}; representative expected duration is ${durationMs}ms.`
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
