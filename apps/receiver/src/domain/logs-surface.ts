/**
 * logs-surface.ts — Builds the LogsSurface for curated evidence responses.
 *
 * Clusters logs by service + severity + trace correlation + keyword hits,
 * classifies each entry as signal or noise, caps per-cluster entries,
 * and delegates absence detection to absence-detector.ts.
 */

import type { TelemetryLog, TelemetryStoreDriver } from '../telemetry/interface.js'
import { buildIncidentQueryFilter } from '../telemetry/interface.js'
import type { TelemetryScope, AnomalousSignal } from '../storage/interface.js'
import type { LogsSurface, LogCluster, LogEntry, LogClusterKey, EvidenceRef } from '@3amoncall/core'
import { LOG_KEYWORDS } from '../telemetry/constants.js'
import { detectAbsences } from './absence-detector.js'

// ── Constants ────────────────────────────────────────────────────────────

const MAX_ENTRIES_PER_CLUSTER = 50

/** Pre-compiled lowercase keyword patterns for efficient matching. */
const KEYWORD_PATTERNS = LOG_KEYWORDS.map((kw) => kw.toLowerCase())

// ── Severity helpers ────────────────────────────────────────────────────

type SeverityDominant = 'FATAL' | 'ERROR' | 'WARN' | 'INFO'

const SEVERITY_RANK: Record<string, number> = {
  FATAL: 3,
  ERROR: 2,
  WARN: 1,
  INFO: 0,
}

function severityRank(severity: string): number {
  return SEVERITY_RANK[severity.toUpperCase()] ?? 0
}

function higherSeverity(a: SeverityDominant, b: SeverityDominant): SeverityDominant {
  return severityRank(a) >= severityRank(b) ? a : b
}

function toSeverityDominant(severity: string): SeverityDominant {
  const upper = severity.toUpperCase()
  if (upper === 'FATAL' || upper === 'ERROR' || upper === 'WARN') return upper
  return 'INFO'
}

// ── Signal / Keyword detection ──────────────────────────────────────────

function findKeywordHits(body: string): string[] {
  const lower = body.toLowerCase()
  const hits: string[] = []
  for (let i = 0; i < LOG_KEYWORDS.length; i++) {
    if (lower.includes(KEYWORD_PATTERNS[i])) {
      hits.push(LOG_KEYWORDS[i])
    }
  }
  return hits
}

function isSignalLog(severity: string, body: string): boolean {
  const upper = severity.toUpperCase()
  if (upper === 'FATAL' || upper === 'ERROR') return true
  return KEYWORD_PATTERNS.some((kw) => body.toLowerCase().includes(kw))
}

// ── Main Entry ───────────────────────────────────────────────────────────

export async function buildLogsSurface(
  telemetryStore: TelemetryStoreDriver,
  telemetryScope: TelemetryScope,
  anomalousSignals: AnomalousSignal[],
  spanMembership: string[],
): Promise<{ surface: LogsSurface; evidenceRefs: Map<string, EvidenceRef> }> {
  const evidenceRefs = new Map<string, EvidenceRef>()

  // 1. Query logs
  const filter = buildIncidentQueryFilter(telemetryScope)
  const allLogs = await telemetryStore.queryLogs(filter)

  // Build set of traceIds from spanMembership ("traceId:spanId" → extract traceId)
  const membershipTraceIds = new Set<string>()
  for (const key of spanMembership) {
    const colonIdx = key.indexOf(':')
    if (colonIdx > 0) {
      membershipTraceIds.add(key.substring(0, colonIdx))
    }
  }

  // 2 & 3. Build LogEntry for each log and classify
  const logEntries: { entry: LogEntry; log: TelemetryLog; keywordHits: string[] }[] = []

  for (const log of allLogs) {
    const signal = isSignalLog(log.severity, log.body)
    const keywords = findKeywordHits(log.body)

    const entry: LogEntry = {
      refId: `${log.service}:${log.timestamp}:${log.bodyHash}`,
      timestamp: log.timestamp,
      severity: log.severity,
      body: log.body,
      isSignal: signal,
      traceId: log.traceId,
      spanId: log.spanId,
    }

    logEntries.push({ entry, log, keywordHits: keywords })
  }

  // 4. Cluster by LogClusterKey
  // We need to compute per-entry trace correlation and keyword hits,
  // then group with matching key components.
  // Group key = "${primaryService}|${severityDominant}|${hasTraceCorrelation}|${keywordHits.sort().join(',')}"
  const clusterMap = new Map<string, {
    entries: LogEntry[]
    keywordHitsSet: Set<string>
    service: string
    hasTraceCorrelation: boolean
  }>()

  for (const { entry, log, keywordHits } of logEntries) {
    const hasTraceCorrelation = log.traceId !== undefined && membershipTraceIds.has(log.traceId)
    const sevDominant = toSeverityDominant(log.severity)

    // Build a preliminary group key
    const sortedKeywords = [...new Set(keywordHits)].sort()
    const groupKey = `${log.service}|${sevDominant}|${hasTraceCorrelation}|${sortedKeywords.join(',')}`

    const existing = clusterMap.get(groupKey)
    if (existing) {
      existing.entries.push(entry)
      for (const kw of keywordHits) existing.keywordHitsSet.add(kw)
    } else {
      clusterMap.set(groupKey, {
        entries: [entry],
        keywordHitsSet: new Set(keywordHits),
        service: log.service,
        hasTraceCorrelation,
      })
    }
  }

  // 5. Build LogCluster from each group
  let clusters: LogCluster[] = []
  let clusterIndex = 0

  for (const [, group] of clusterMap) {
    // Cap entries
    const capped = group.entries.slice(0, MAX_ENTRIES_PER_CLUSTER)
    const signalCount = capped.filter((e) => e.isSignal).length
    const noiseCount = capped.filter((e) => !e.isSignal).length

    // Determine severityDominant from the actual entries in cluster
    let sevDominant: SeverityDominant = 'INFO'
    for (const e of capped) {
      sevDominant = higherSeverity(sevDominant, toSeverityDominant(e.severity))
    }

    const clusterKey: LogClusterKey = {
      primaryService: group.service,
      severityDominant: sevDominant,
      hasTraceCorrelation: group.hasTraceCorrelation,
      keywordHits: [...group.keywordHitsSet].sort(),
    }

    const clusterId = `lcluster:${clusterIndex}`
    clusterIndex++

    clusters.push({
      clusterId,
      clusterKey,
      diagnosisLabel: undefined,
      diagnosisVerdict: undefined,
      entries: capped,
      signalCount,
      noiseCount,
    })
  }

  // 6. Sort clusters by signalCount descending
  clusters.sort((a, b) => b.signalCount - a.signalCount)

  // 7. Detect absences
  const absenceResult = await detectAbsences(telemetryStore, telemetryScope, anomalousSignals)

  // 8. Build evidenceRefs
  // For log entries in clusters
  for (const cluster of clusters) {
    for (const entry of cluster.entries) {
      evidenceRefs.set(entry.refId, {
        refId: entry.refId,
        surface: 'logs',
        groupId: cluster.clusterId,
      })
    }
  }

  // For absences
  for (const [refId, ref] of absenceResult.evidenceRefs) {
    evidenceRefs.set(refId, ref)
  }

  return {
    surface: {
      clusters,
      absenceEvidence: absenceResult.entries,
    },
    evidenceRefs,
  }
}
