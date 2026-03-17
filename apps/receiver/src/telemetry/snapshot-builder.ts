/**
 * snapshot-builder.ts — Orchestrator for TelemetryStore-based evidence selection.
 *
 * Replaces `fetchAndRebuild` when TelemetryStore is available (ADR 0032 Decision 4, P2-5).
 *
 * Flow:
 *   1. Re-read rawState + fresh incident from storage (stale avoidance)
 *   2. Compute incident window + scope from rawState spans
 *   3. Query TelemetryStore for spans/metrics/logs (incident + baseline windows)
 *   4. Score + select evidence via scoring + diversityFill
 *   5. Upsert 3 snapshots (traces, metrics, logs)
 *   6. Build pointers from TelemetryStore data + snapshot selections
 *   7. Rebuild packet with snapshot evidence and persist
 */

import type { ChangedMetric, RelevantLog } from '@3amoncall/core'
import type { TelemetryStoreDriver, TelemetrySpan, TelemetryQueryFilter } from './interface.js'
import type { StorageDriver, IncidentRawState } from '../storage/interface.js'
import type { ExtractedSpan } from '../domain/anomaly-detector.js'
import { isAnomalous } from '../domain/anomaly-detector.js'
import {
  selectRepresentativeTraces,
  rebuildPacket,
  buildPlatformLogRef,
} from '../domain/packetizer.js'
import { scoreMetrics } from './scoring/metric-scorer.js'
import { scoreLogs } from './scoring/log-scorer.js'
import { diversityFill } from './scoring/diversity-fill.js'
import {
  MAX_CHANGED_METRICS,
  MAX_RELEVANT_LOGS,
  MAX_TRACE_REFS,
  METRIC_TOP_GUARANTEE,
  METRIC_MAX_PER_SERVICE,
  LOG_TOP_GUARANTEE,
  LOG_MAX_PER_SERVICE,
  BASELINE_MULTIPLIER,
} from './constants.js'

// ---------------------------------------------------------------------------
// TelemetrySpan → ExtractedSpan conversion
// ---------------------------------------------------------------------------

function toExtractedSpan(ts: TelemetrySpan): ExtractedSpan {
  return {
    traceId: ts.traceId,
    spanId: ts.spanId,
    parentSpanId: ts.parentSpanId,
    serviceName: ts.serviceName,
    environment: ts.environment,
    httpRoute: ts.httpRoute,
    httpStatusCode: ts.httpStatusCode,
    spanStatusCode: ts.spanStatusCode,
    durationMs: ts.durationMs,
    startTimeMs: ts.startTimeMs,
    exceptionCount: ts.exceptionCount,
    peerService: ts.peerService,
    spanName: ts.spanName,
  }
}

// ---------------------------------------------------------------------------
// Window + scope computation (mirrors rebuildPacket logic)
// ---------------------------------------------------------------------------

function computeWindowAndScope(rawState: IncidentRawState) {
  const { spans } = rawState
  if (spans.length === 0) {
    return null
  }

  const windowStartMs = Math.min(...spans.map(s => s.startTimeMs))
  const windowEndMs = Math.max(...spans.map(s => s.startTimeMs + s.durationMs))
  const firstAnomalous = spans.filter(isAnomalous)[0]
  const detectTimeMs = firstAnomalous ? firstAnomalous.startTimeMs : windowStartMs

  const environment = spans[0]?.environment ?? 'unknown'
  // Include both serviceName and peerService (affectedDependencies) in the query scope.
  // This matches shouldAttachEvidence() which attaches metrics/logs from dependency services
  // (e.g., stripe) that are in affectedDependencies. Without this, TelemetryStore queries
  // would miss dependency-originated evidence that rawState path correctly includes.
  const serviceNames = new Set(spans.map(s => s.serviceName))
  for (const s of spans) {
    if (s.peerService !== undefined) {
      serviceNames.add(s.peerService)
    }
  }
  const services = [...serviceNames]

  return {
    windowStartMs,
    windowEndMs,
    detectTimeMs,
    environment,
    services,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Rebuild curated evidence snapshots from TelemetryStore and update the incident packet.
 *
 * This function REPLACES fetchAndRebuild when TelemetryStore is available.
 * It takes only incidentId (not an incident object) to avoid stale data —
 * internally re-reads rawState + incident from storage.
 */
export async function rebuildSnapshots(
  incidentId: string,
  telemetryStore: TelemetryStoreDriver,
  storage: StorageDriver,
): Promise<void> {
  // Step 1: Re-read rawState + fresh incident (stale avoidance, same as fetchAndRebuild)
  const [rawState, fresh] = await Promise.all([
    storage.getRawState(incidentId),
    storage.getIncident(incidentId),
  ])
  if (rawState === null || fresh === null) return

  // Step 2: Compute window + scope from rawState spans
  const windowScope = computeWindowAndScope(rawState)
  if (!windowScope) {
    // No spans yet — nothing to query/select
    return
  }

  const { windowStartMs, windowEndMs, detectTimeMs, environment, services } = windowScope

  // Step 3: Build query filter for incident window
  const incidentFilter: TelemetryQueryFilter = {
    startMs: windowStartMs,
    endMs: windowEndMs,
    services,
    environment,
  }

  // Step 4: Query TelemetryStore for incident window data
  const [tsSpans, tsMetrics, tsLogs] = await Promise.all([
    telemetryStore.querySpans(incidentFilter),
    telemetryStore.queryMetrics(incidentFilter),
    telemetryStore.queryLogs(incidentFilter),
  ])

  // Step 5: Query baseline metrics (4x window before incident start)
  const windowDuration = windowEndMs - windowStartMs
  const baselineStartMs = windowStartMs - windowDuration * BASELINE_MULTIPLIER
  const baselineFilter: TelemetryQueryFilter = {
    startMs: baselineStartMs,
    endMs: windowStartMs - 1, // exclusive of incident window
    services,
    environment,
  }
  const baselineMetrics = await telemetryStore.queryMetrics(baselineFilter)

  // Step 6: Get anomalous signals from rawState, anomalous traceIds
  const { anomalousSignals, platformEvents } = rawState
  const anomalousTraceIds = new Set(
    rawState.spans.filter(isAnomalous).map(s => s.traceId),
  )

  // Step 7: Score + select traces
  const extractedSpans = tsSpans.map(toExtractedSpan)
  const representativeTraces = selectRepresentativeTraces(extractedSpans)

  // Step 8: Score + select metrics
  const scoredMetrics = scoreMetrics(tsMetrics, baselineMetrics, anomalousSignals, {
    startMs: windowStartMs,
    endMs: windowEndMs,
  })
  const selectedMetrics = diversityFill(scoredMetrics, {
    maxItems: MAX_CHANGED_METRICS,
    topGuarantee: METRIC_TOP_GUARANTEE,
    getScore: m => m.score,
    getServiceKey: m => m.service,
    getDiversityKey: m => `${m.service}:${m.name}`,
    maxPerDiversityKey: METRIC_MAX_PER_SERVICE,
    getIdentityKey: m => `${m.service}:${m.name}:${m.startTimeMs}`,
  })

  // Step 9: Score + select logs
  const scoredLogs = scoreLogs(tsLogs, detectTimeMs, anomalousTraceIds)
  const selectedLogs = diversityFill(scoredLogs, {
    maxItems: MAX_RELEVANT_LOGS,
    topGuarantee: LOG_TOP_GUARANTEE,
    getScore: l => l.score,
    getServiceKey: l => l.service,
    getDiversityKey: l => `${l.service}:${l.body}`,
    maxPerDiversityKey: LOG_MAX_PER_SERVICE,
    getIdentityKey: l => `${l.service}:${l.timestamp}:${l.bodyHash}`,
  })

  // Step 10: Convert to packet types (drop scoring-only fields)
  const changedMetrics: ChangedMetric[] = selectedMetrics.map(m => ({
    name: m.name,
    service: m.service,
    environment: m.environment,
    startTimeMs: m.startTimeMs,
    summary: m.summary,
  }))

  const relevantLogs: RelevantLog[] = selectedLogs.map(l => ({
    service: l.service,
    environment: l.environment,
    timestamp: l.timestamp,
    startTimeMs: l.startTimeMs,
    severity: l.severity,
    body: l.body,
    attributes: l.attributes,
  }))

  // Step 11: Upsert 3 snapshots
  await Promise.all([
    telemetryStore.upsertSnapshot(incidentId, 'traces', representativeTraces),
    telemetryStore.upsertSnapshot(incidentId, 'metrics', changedMetrics),
    telemetryStore.upsertSnapshot(incidentId, 'logs', relevantLogs),
  ])

  // Step 12: Build pointers from snapshot + TelemetryStore data
  // traceRefs: ALL distinct traceIds from TelemetryStore query (broader than representative), capped.
  // Sort deterministically so packet diff is stable across adapter implementations and re-runs.
  const allTraceIds = [...new Set(tsSpans.map(s => s.traceId))].sort()
  const traceRefs = allTraceIds.slice(0, MAX_TRACE_REFS)

  // metricRefs: distinct names from selected metrics
  const metricRefs = [...new Set(changedMetrics.map(m => m.name))]

  // logRefs: service:timestamp from selected logs
  const logRefs = [...new Set(relevantLogs.map(l => `${l.service}:${l.timestamp}`))]

  // platformLogRefs: from rawState.platformEvents (unchanged)
  const platformLogRefs = platformEvents.map(buildPlatformLogRef)

  // Step 13: Rebuild packet — use existing rebuildPacket then override evidence + pointers
  const generation = (fresh.packet.generation ?? 1) + 1
  const rebuiltPacket = rebuildPacket(
    incidentId,
    fresh.packet.packetId,
    fresh.openedAt,
    rawState,
    generation,
    fresh.packet.scope.primaryService,
  )

  // Override evidence and pointers with snapshot-sourced data
  rebuiltPacket.evidence.changedMetrics = changedMetrics
  rebuiltPacket.evidence.relevantLogs = relevantLogs
  rebuiltPacket.evidence.representativeTraces = representativeTraces
  rebuiltPacket.pointers.traceRefs = traceRefs
  rebuiltPacket.pointers.metricRefs = metricRefs
  rebuiltPacket.pointers.logRefs = logRefs
  rebuiltPacket.pointers.platformLogRefs = platformLogRefs

  // Step 14: Persist
  await storage.createIncident(rebuiltPacket)
}
