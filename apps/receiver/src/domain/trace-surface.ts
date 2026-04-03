/**
 * trace-surface.ts — Builds the TraceSurface for curated evidence responses.
 *
 * Produces observed (incident-bound) and expected (baseline) GroupedTrace
 * arrays, identifies the smoking-gun span, and emits EvidenceRef entries
 * for the evidence index.
 */

import type { TelemetrySpan, TelemetryLog, TelemetryStoreDriver } from '../telemetry/interface.js'
import { buildIncidentQueryFilter } from '../telemetry/interface.js'
import type { Incident } from '../storage/interface.js'
import { spanMembershipKey } from '../storage/interface.js'
import type {
  CuratedTraceSurface,
  CuratedGroupedTrace,
  CuratedTraceSpan,
  CuratedEvidenceRef,
} from '@3am/core/schemas/curated-evidence'
import { selectBaseline, deriveDominantOperation } from './baseline-selector.js'

// ── Constants ────────────────────────────────────────────────────────────

const SLOW_SPAN_THRESHOLD_MS = 5_000
const MAX_OBSERVED_TRACES = 10
const MAX_CORRELATED_LOGS_PER_SPAN = 4
const CORRELATED_LOG_WINDOW_MS = 2_000

// ── Span Status Helpers ──────────────────────────────────────────────────

type SpanStatus = 'ok' | 'error' | 'slow'

function classifySpanStatus(
  httpStatusCode: number | undefined,
  spanStatusCode: number,
  durationMs: number,
): SpanStatus {
  if ((httpStatusCode !== undefined && httpStatusCode >= 500) || spanStatusCode === 2) {
    return 'error'
  }
  if (durationMs > SLOW_SPAN_THRESHOLD_MS) {
    return 'slow'
  }
  return 'ok'
}

function classifyTraceStatus(spans: TelemetrySpan[], rootDurationMs: number): SpanStatus {
  for (const span of spans) {
    if (
      (span.httpStatusCode !== undefined && span.httpStatusCode >= 500) ||
      span.spanStatusCode === 2
    ) {
      return 'error'
    }
  }
  if (rootDurationMs > SLOW_SPAN_THRESHOLD_MS) {
    return 'slow'
  }
  return 'ok'
}

/** Status severity ordering for sort: error > slow > ok. */
function statusSeverity(status: SpanStatus): number {
  switch (status) {
    case 'error': return 0
    case 'slow': return 1
    case 'ok': return 2
  }
}

// ── Scoring (mirrors packetizer.ts scoreSpan) ────────────────────────────

function scoreTelemetrySpan(span: TelemetrySpan): number {
  let score = 0
  if (span.httpStatusCode !== undefined && span.httpStatusCode >= 500) score += 3
  if (span.httpStatusCode === 429) score += 3
  if (span.exceptionCount > 0) score += 2
  if (span.spanStatusCode === 2) score += 2
  if (span.durationMs > SLOW_SPAN_THRESHOLD_MS) score += 1
  if (span.peerService !== undefined) score += 1
  return score
}

// ── Grouping ─────────────────────────────────────────────────────────────

function groupSpansByTrace(spans: TelemetrySpan[]): Map<string, TelemetrySpan[]> {
  const groups = new Map<string, TelemetrySpan[]>()
  for (const span of spans) {
    const group = groups.get(span.traceId)
    if (group) {
      group.push(span)
    } else {
      groups.set(span.traceId, [span])
    }
  }
  return groups
}

function findRootSpan(spans: TelemetrySpan[]): TelemetrySpan {
  const spanIdSet = new Set(spans.map((s) => s.spanId))

  // Root = no parentSpanId, or parentSpanId not in this group
  const candidates = spans.filter(
    (s) => !s.parentSpanId || !spanIdSet.has(s.parentSpanId),
  )

  if (candidates.length === 0) {
    // Fallback: pick the span with the earliest startTimeMs
    return spans.reduce((earliest, s) =>
      s.startTimeMs < earliest.startTimeMs ? s : earliest,
    )
  }

  // Among candidates, prefer the one with the earliest startTimeMs
  return candidates.reduce((earliest, s) =>
    s.startTimeMs < earliest.startTimeMs ? s : earliest,
  )
}

function logRefId(log: TelemetryLog): string {
  return `${log.service}:${log.timestamp}:${log.bodyHash}`
}

function buildCorrelatedLogRefs(span: TelemetrySpan, logs: TelemetryLog[]): string[] {
  const windowStartMs = span.startTimeMs - CORRELATED_LOG_WINDOW_MS
  const windowEndMs = span.startTimeMs + span.durationMs + CORRELATED_LOG_WINDOW_MS

  return logs
    .filter((log) => log.startTimeMs >= windowStartMs && log.startTimeMs <= windowEndMs)
    .map((log) => ({
      refId: logRefId(log),
      rank:
        log.spanId === span.spanId && log.traceId === span.traceId
          ? 0
          : log.traceId === span.traceId
            ? 1
            : log.service === span.serviceName
              ? 2
              : 3,
      timeDistanceMs: Math.abs(log.startTimeMs - span.startTimeMs),
      startTimeMs: log.startTimeMs,
    }))
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank
      if (a.timeDistanceMs !== b.timeDistanceMs) return a.timeDistanceMs - b.timeDistanceMs
      if (a.startTimeMs !== b.startTimeMs) return a.startTimeMs - b.startTimeMs
      return a.refId.localeCompare(b.refId)
    })
    .slice(0, MAX_CORRELATED_LOGS_PER_SPAN)
    .map((log) => log.refId)
}

function buildTraceSpan(
  span: TelemetrySpan,
  rootStartTimeMs: number,
  rootDurationMs: number,
  logs: TelemetryLog[],
): CuratedTraceSpan {
  const offsetMs = span.startTimeMs - rootStartTimeMs
  const widthPct = rootDurationMs > 0 ? (span.durationMs / rootDurationMs) * 100 : 0

  return {
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    refId: `${span.traceId}:${span.spanId}`,
    spanName: span.spanName,
    durationMs: span.durationMs,
    httpStatusCode: span.httpStatusCode,
    spanStatusCode: span.spanStatusCode,
    offsetMs,
    widthPct,
    status: classifySpanStatus(span.httpStatusCode, span.spanStatusCode, span.durationMs),
    peerService: span.peerService,
    attributes: span.attributes,
    correlatedLogRefIds: buildCorrelatedLogRefs(span, logs),
  }
}

function buildGroupedTrace(
  traceId: string,
  spans: TelemetrySpan[],
  logs: TelemetryLog[],
): CuratedGroupedTrace {
  const root = findRootSpan(spans)
  const rootDurationMs = root.durationMs
  const rootStartTimeMs = root.startTimeMs

  const traceSpans: CuratedTraceSpan[] = spans.map((s) =>
    buildTraceSpan(s, rootStartTimeMs, rootDurationMs, logs),
  )

  return {
    traceId,
    groupId: `trace:${traceId}`,
    rootSpanName: root.spanName,
    httpStatusCode: root.httpStatusCode,
    durationMs: rootDurationMs,
    status: classifyTraceStatus(spans, rootDurationMs),
    startTimeMs: rootStartTimeMs,
    spans: traceSpans,
  }
}

// ── Main Entry ───────────────────────────────────────────────────────────

export async function buildTraceSurface(
  incident: Incident,
  telemetryStore: TelemetryStoreDriver,
): Promise<{ surface: CuratedTraceSurface; evidenceRefs: Map<string, CuratedEvidenceRef> }> {
  const evidenceRefs = new Map<string, CuratedEvidenceRef>()

  // ── Observed traces ──────────────────────────────────────────────────

  const filter = buildIncidentQueryFilter(incident.telemetryScope)
  const [allSpans, allLogs] = await Promise.all([
    telemetryStore.querySpans(filter),
    telemetryStore.queryLogs(filter),
  ])

  // Diagnostic logging for #169 — evidence empty despite D1 data
  console.log('[trace-surface] query filter:', JSON.stringify(filter))
  console.log('[trace-surface] querySpans returned:', allSpans.length, 'rows')
  console.log('[trace-surface] queryLogs returned:', allLogs.length, 'rows')
  console.log('[trace-surface] spanMembership size:', incident.spanMembership.length)

  // Filter to incident-bound spans only
  const membershipSet = new Set(incident.spanMembership)
  const incidentSpans = allSpans.filter((s) =>
    membershipSet.has(spanMembershipKey(s.traceId, s.spanId)),
  )

  console.log('[trace-surface] incidentSpans after membership filter:', incidentSpans.length)
  if (allSpans.length > 0 && incidentSpans.length === 0) {
    // Log a sample span key vs membership keys for mismatch debugging
    const sampleSpan = allSpans[0]!
    const sampleKey = spanMembershipKey(sampleSpan.traceId, sampleSpan.spanId)
    const sampleMembership = incident.spanMembership.slice(0, 3)
    console.log('[trace-surface] KEY MISMATCH DEBUG — sample span key:', sampleKey, 'sample membership keys:', sampleMembership)
  }

  // Group by traceId
  const observedGroups = groupSpansByTrace(incidentSpans)
  let observedTraces: CuratedGroupedTrace[] = []
  for (const [traceId, spans] of observedGroups) {
    observedTraces.push(buildGroupedTrace(traceId, spans, allLogs))
  }

  // Sort by status severity (error first, then slow, then ok),
  // within same status by startTimeMs ascending
  observedTraces.sort((a, b) => {
    const severityDiff = statusSeverity(a.status) - statusSeverity(b.status)
    if (severityDiff !== 0) return severityDiff
    return a.startTimeMs - b.startTimeMs
  })

  // Limit to MAX_OBSERVED_TRACES
  observedTraces = observedTraces.slice(0, MAX_OBSERVED_TRACES)

  // ── Smoking-gun span ─────────────────────────────────────────────────

  let smokingGunSpanId: string | undefined
  let highestScore = 0

  for (const span of incidentSpans) {
    const score = scoreTelemetrySpan(span)
    if (score > highestScore) {
      highestScore = score
      smokingGunSpanId = `${span.traceId}:${span.spanId}`
    }
  }

  // If highest score is 0 (no anomalous spans), leave undefined
  if (highestScore === 0) {
    smokingGunSpanId = undefined
  }

  // ── Expected (baseline) traces ───────────────────────────────────────

  const primaryService = incident.packet.scope.primaryService
  const dominantOperation = deriveDominantOperation(incidentSpans, primaryService)

  const baselineResult = await selectBaseline(telemetryStore, {
    incidentWindowStartMs: incident.telemetryScope.windowStartMs,
    incidentWindowEndMs: incident.telemetryScope.windowEndMs,
    primaryService,
    operation: dominantOperation,
  })

  const baselineGroups = groupSpansByTrace(baselineResult.spans)
  const expectedTraces: CuratedGroupedTrace[] = []
  for (const [traceId, spans] of baselineGroups) {
    expectedTraces.push(buildGroupedTrace(traceId, spans, allLogs))
  }

  // ── Build EvidenceRefs ───────────────────────────────────────────────

  for (const trace of observedTraces) {
    for (const span of trace.spans) {
      evidenceRefs.set(span.refId, {
        refId: span.refId,
        surface: 'traces',
        groupId: trace.groupId,
        isSmokingGun: span.refId === smokingGunSpanId,
      })
    }
  }

  for (const trace of expectedTraces) {
    for (const span of trace.spans) {
      evidenceRefs.set(span.refId, {
        refId: span.refId,
        surface: 'traces',
        groupId: trace.groupId,
        isSmokingGun: false,
      })
    }
  }

  return {
    surface: {
      observed: observedTraces,
      expected: expectedTraces,
      smokingGunSpanId,
      baseline: baselineResult.context,
    },
    evidenceRefs,
  }
}
