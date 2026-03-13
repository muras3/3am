import { randomUUID } from "crypto"
import type { IncidentPacket } from "@3amoncall/core"
import { type ExtractedSpan, isAnomalous } from "./anomaly-detector.js"
import type { AnomalousSignal, IncidentRawState } from "../storage/interface.js"

type RepresentativeTrace = {
  traceId: string
  spanId: string
  serviceName: string
  durationMs: number
  httpStatusCode?: number
  spanStatusCode: number
}

export function buildAnomalousSignals(anomalousSpans: ExtractedSpan[]): AnomalousSignal[] {
  return anomalousSpans.map((span): AnomalousSignal => {
    const signal =
      span.httpStatusCode !== undefined
        ? `http_${span.httpStatusCode}`
        : span.exceptionCount > 0
          ? "exception"
          : span.spanStatusCode === 2
            ? "span_error"
            : "slow_span"
    return {
      signal,
      firstSeenAt: new Date(span.startTimeMs).toISOString(),
      entity: span.serviceName,
      spanId: span.spanId,
    }
  })
}

export function selectPrimaryService(spans: ExtractedSpan[]): string {
  const anomalous = spans
    .filter(isAnomalous)
    .slice()
    .sort((a, b) =>
      a.startTimeMs !== b.startTimeMs
        ? a.startTimeMs - b.startTimeMs
        : a.serviceName.localeCompare(b.serviceName),
    )
  return anomalous[0]?.serviceName ?? spans[0]?.serviceName ?? "unknown"
}

export function rebuildPacket(
  incidentId: string,
  packetId: string,
  openedAt: string,
  rawState: IncidentRawState,
  existingEvidence?: { changedMetrics?: unknown[]; relevantLogs?: unknown[]; platformEvents?: unknown[] },
  generation?: number,
  primaryService?: string,
): IncidentPacket {
  const { spans, anomalousSignals } = rawState

  // window
  const windowStart = Math.min(...spans.map((s) => s.startTimeMs))
  const windowEnd = Math.max(...spans.map((s) => s.startTimeMs + s.durationMs))
  const firstAnomalousSpan = spans.filter(isAnomalous)[0]
  const windowDetect = firstAnomalousSpan ? firstAnomalousSpan.startTimeMs : windowStart

  // scope
  const environment = spans[0]?.environment ?? "unknown"
  // NOTE: primaryService is immutable after incident creation (ADR 0018 amendment).
  // Rebuilds preserve the original triggering service instead of recalculating it.
  const resolvedPrimaryService = primaryService ?? selectPrimaryService(spans)
  // NOTE: affectedServices always includes primaryService.
  // shouldAttachToIncident() relies on this guarantee when evaluating the
  // MAX_CROSS_SERVICE_MERGE guard (see formation.ts).
  const affectedServices = [...new Set(spans.map((s) => s.serviceName))]
  const affectedRoutes = [...new Set(spans.flatMap((s) => (s.httpRoute ? [s.httpRoute] : [])))]
  const affectedDependencies = [...new Set(spans.flatMap((s) => (s.peerService ? [s.peerService] : [])))]

  // triggerSignals: dedup by signal+entity, keep earliest firstSeenAt per group
  const groupMap = new Map<string, { signal: string; firstSeenAt: string; entity: string }>()
  for (const sig of anomalousSignals) {
    const key = `${sig.signal}|${sig.entity}`
    const existing = groupMap.get(key)
    if (!existing || sig.firstSeenAt < existing.firstSeenAt) {
      groupMap.set(key, { signal: sig.signal, firstSeenAt: sig.firstSeenAt, entity: sig.entity })
    }
  }
  const triggerSignals = [...groupMap.values()]

  // representativeTraces
  const representativeTraces: RepresentativeTrace[] = spans.slice(0, 10).map((s) => ({
    traceId: s.traceId,
    spanId: s.spanId,
    serviceName: s.serviceName,
    durationMs: s.durationMs,
    httpStatusCode: s.httpStatusCode,
    spanStatusCode: s.spanStatusCode,
  }))

  // pointers
  const traceRefs = [...new Set(spans.map((s) => s.traceId))]

  return {
    schemaVersion: "incident-packet/v1alpha1",
    packetId,
    incidentId,
    openedAt,
    status: "open",
    generation: generation ?? 1,
    window: {
      start: new Date(windowStart).toISOString(),
      detect: new Date(windowDetect).toISOString(),
      end: new Date(windowEnd).toISOString(),
    },
    scope: {
      environment,
      primaryService: resolvedPrimaryService,
      affectedServices,
      affectedRoutes,
      affectedDependencies,
    },
    triggerSignals,
    evidence: {
      changedMetrics: existingEvidence?.changedMetrics ?? [],
      representativeTraces,
      relevantLogs: existingEvidence?.relevantLogs ?? [],
      platformEvents: existingEvidence?.platformEvents ?? [],
    },
    pointers: {
      traceRefs,
      logRefs: [],
      metricRefs: [],
      platformLogRefs: [],
    },
  }
}

export function createPacket(
  incidentId: string,
  openedAt: string,
  spans: ExtractedSpan[],
): IncidentPacket {
  const primaryService = selectPrimaryService(spans)
  const rawState: IncidentRawState = {
    spans,
    anomalousSignals: buildAnomalousSignals(spans.filter(isAnomalous)),
    metricEvidence: [],
    logEvidence: [],
    platformEvents: [],
  }
  const packetId = randomUUID()
  return rebuildPacket(incidentId, packetId, openedAt, rawState, undefined, 1, primaryService)
}
