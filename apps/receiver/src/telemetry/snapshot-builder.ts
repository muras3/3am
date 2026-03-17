/**
 * snapshot-builder.ts — Orchestrator for TelemetryStore-based evidence selection.
 *
 * Reads incident membership data (telemetryScope, spanMembership, anomalousSignals,
 * platformEvents) from StorageDriver, queries TelemetryStore, scores + selects evidence,
 * and rebuilds the incident packet.
 *
 * Flow:
 *   1. Read incident from storage (gets telemetryScope, spanMembership, etc.)
 *   2. Build TelemetryQueryFilter from telemetryScope
 *   3. Query TelemetryStore for spans/metrics/logs (incident + baseline windows)
 *   4. Filter spans by spanMembership → memberSpans (incident-bound)
 *   5. Derive scope from memberSpans
 *   6. Score + select evidence via scoring + diversityFill
 *   7. Upsert 3 snapshots
 *   8. Build packet directly and persist via updatePacket
 */

import type { ChangedMetric, IncidentPacket, RelevantLog } from '@3amoncall/core'
import type { TelemetryStoreDriver, TelemetrySpan } from './interface.js'
import { buildIncidentQueryFilter } from './interface.js'
import type { StorageDriver } from '../storage/interface.js'
import { spanMembershipKey } from '../storage/interface.js'
import type { ExtractedSpan } from '../domain/anomaly-detector.js'
import { isAnomalous } from '../domain/anomaly-detector.js'
import { normalizeDependency } from '../domain/formation.js'
import {
  selectRepresentativeTraces,
  deriveSignalSeverity,
  deduplicateTriggerSignals,
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
    httpMethod: ts.httpMethod,
    spanKind: ts.spanKind,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Rebuild curated evidence snapshots from TelemetryStore and update the incident packet.
 *
 * Reads incident membership (telemetryScope, spanMembership, anomalousSignals,
 * platformEvents) from StorageDriver, queries TelemetryStore, and persists the
 * rebuilt packet via storage.updatePacket() — compact fields are preserved.
 */
export async function rebuildSnapshots(
  incidentId: string,
  telemetryStore: TelemetryStoreDriver,
  storage: StorageDriver,
): Promise<void> {
  // Step 1: Read incident from storage
  const incident = await storage.getIncident(incidentId)
  if (incident === null) return

  const { telemetryScope, spanMembership, anomalousSignals, platformEvents } = incident

  // Guard: need valid telemetryScope
  if (telemetryScope.windowStartMs >= telemetryScope.windowEndMs) {
    return
  }

  // Step 2: Build query filter from telemetryScope
  const incidentFilter = buildIncidentQueryFilter(telemetryScope)

  // Step 3+4: Query TelemetryStore for incident window data + baseline metrics in parallel
  const windowDuration = telemetryScope.windowEndMs - telemetryScope.windowStartMs
  const baselineStartMs = telemetryScope.windowStartMs - windowDuration * BASELINE_MULTIPLIER
  const baselineFilter = {
    ...incidentFilter,
    startMs: baselineStartMs,
    endMs: telemetryScope.windowStartMs - 1, // exclusive of incident window
  }
  const [tsSpans, tsMetrics, tsLogs, baselineMetrics] = await Promise.all([
    telemetryStore.querySpans(incidentFilter),
    telemetryStore.queryMetrics(incidentFilter),
    telemetryStore.queryLogs(incidentFilter),
    telemetryStore.queryMetrics(baselineFilter),
  ])

  // Step 5: Filter spans by spanMembership → incident-bound memberSpans
  const spanMembershipSet = new Set(spanMembership)
  const memberTsSpans = tsSpans.filter(s => spanMembershipSet.has(spanMembershipKey(s.traceId, s.spanId)))
  const memberSpans = memberTsSpans.map(toExtractedSpan)

  // Step 6: Derive scope from memberSpans
  const affectedServices = [...new Set(memberSpans.map(s => s.serviceName))]
  const affectedRoutes = [...new Set(memberSpans.flatMap(s => s.httpRoute ? [s.httpRoute] : []))]
  const affectedDependencies = [
    ...new Set(
      memberSpans.flatMap(s => {
        const dep = normalizeDependency(s.peerService)
        return dep !== undefined ? [dep] : []
      }),
    ),
  ]

  // Step 7: triggerSignals — dedup by signal+entity, keep earliest firstSeenAt
  const triggerSignals = deduplicateTriggerSignals(anomalousSignals)

  // Step 8: representativeTraces from incident-bound memberSpans
  const representativeTraces = selectRepresentativeTraces(memberSpans)

  // Step 9: Anomalous traceIds for log scoring (from memberSpans)
  const anomalousTraceIds = new Set(
    memberSpans.filter(isAnomalous).map(s => s.traceId),
  )

  // Step 10: Score + select metrics
  const scoredMetrics = scoreMetrics(tsMetrics, baselineMetrics, anomalousSignals, {
    startMs: telemetryScope.windowStartMs,
    endMs: telemetryScope.windowEndMs,
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

  // Step 11: Score + select logs
  const scoredLogs = scoreLogs(tsLogs, telemetryScope.detectTimeMs, anomalousTraceIds)
  const selectedLogs = diversityFill(scoredLogs, {
    maxItems: MAX_RELEVANT_LOGS,
    topGuarantee: LOG_TOP_GUARANTEE,
    getScore: l => l.score,
    getServiceKey: l => l.service,
    getDiversityKey: l => `${l.service}:${l.body}`,
    maxPerDiversityKey: LOG_MAX_PER_SERVICE,
    getIdentityKey: l => `${l.service}:${l.timestamp}:${l.bodyHash}`,
  })

  // Step 12: Convert to packet types (drop scoring-only fields)
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

  // Step 13: Upsert 3 snapshots
  await Promise.all([
    telemetryStore.upsertSnapshot(incidentId, 'traces', representativeTraces),
    telemetryStore.upsertSnapshot(incidentId, 'metrics', changedMetrics),
    telemetryStore.upsertSnapshot(incidentId, 'logs', relevantLogs),
  ])

  // Step 14: Build pointers
  // traceRefs: ALL distinct traceIds from TelemetryStore query (broader than representative), capped.
  const allTraceIds = [...new Set(tsSpans.map(s => s.traceId))].sort()
  const traceRefs = allTraceIds.slice(0, MAX_TRACE_REFS)
  const metricRefs = [...new Set(changedMetrics.map(m => m.name))]
  const logRefs = [...new Set(relevantLogs.map(l => `${l.service}:${l.timestamp}`))]
  const platformLogRefs = platformEvents.map(buildPlatformLogRef)

  // Step 15: signalSeverity
  const signalSeverity = deriveSignalSeverity(anomalousSignals, relevantLogs, affectedServices.length)

  // Step 16: Build packet directly (no rebuildPacket call)
  const generation = (incident.packet.generation ?? 1) + 1
  const newPacket: IncidentPacket = {
    schemaVersion: 'incident-packet/v1alpha1',
    packetId: incident.packet.packetId,
    incidentId,
    openedAt: incident.openedAt,
    status: incident.packet.status,
    generation,
    signalSeverity,
    window: {
      start: new Date(telemetryScope.windowStartMs).toISOString(),
      detect: new Date(telemetryScope.detectTimeMs).toISOString(),
      end: new Date(telemetryScope.windowEndMs).toISOString(),
    },
    scope: {
      environment: telemetryScope.environment,
      primaryService: incident.packet.scope.primaryService,
      affectedServices,
      affectedRoutes,
      affectedDependencies,
    },
    triggerSignals,
    evidence: {
      changedMetrics,
      representativeTraces,
      relevantLogs,
      platformEvents,
    },
    pointers: {
      traceRefs,
      logRefs,
      metricRefs,
      platformLogRefs,
    },
  }

  // Step 17: Persist via updatePacket — compact fields are preserved
  await storage.updatePacket(incidentId, newPacket)
}
