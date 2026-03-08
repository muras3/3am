import { randomUUID } from "crypto"
import type { IncidentPacket } from "@3amoncall/core"
import { type ExtractedSpan, isAnomalous } from "./anomaly-detector.js"

type RepresentativeTrace = {
  traceId: string
  spanId: string
  serviceName: string
  durationMs: number
  httpStatusCode?: number
  spanStatusCode: number
}

export function createPacket(
  incidentId: string,
  openedAt: string,
  spans: ExtractedSpan[],
): IncidentPacket {
  const windowStart = Math.min(...spans.map((s) => s.startTimeMs))
  const windowEnd = Math.max(...spans.map((s) => s.startTimeMs + s.durationMs))

  const anomalousSpans = spans.filter(isAnomalous)
  const firstAnomalous = anomalousSpans[0]
  const windowDetect = firstAnomalous
    ? firstAnomalous.startTimeMs
    : windowStart

  const triggerSignals = anomalousSpans.map((s) => ({
    signal: s.httpStatusCode !== undefined ? `http_${s.httpStatusCode}` : "span_error",
    firstSeenAt: new Date(s.startTimeMs).toISOString(),
    entity: s.serviceName,
  }))

  return {
    schemaVersion: "incident-packet/v1alpha1",
    packetId: randomUUID(),
    incidentId,
    openedAt,
    status: "open",
    window: {
      start: new Date(windowStart).toISOString(),
      detect: new Date(windowDetect).toISOString(),
      end: new Date(windowEnd).toISOString(),
    },
    scope: {
      environment: spans[0]?.environment ?? "unknown",
      primaryService: spans[0]?.serviceName ?? "unknown",
      affectedServices: [...new Set(spans.map((s) => s.serviceName))],
      affectedRoutes: [...new Set(spans.flatMap((s) => (s.httpRoute ? [s.httpRoute] : [])))],
      affectedDependencies: [...new Set(spans.flatMap((s) => s.peerService ? [s.peerService] : []))],
    },
    triggerSignals,
    evidence: {
      changedMetrics: [],
      representativeTraces: spans.slice(0, 10).map((s): RepresentativeTrace => ({
        traceId: s.traceId,
        spanId: s.spanId,
        serviceName: s.serviceName,
        durationMs: s.durationMs,
        httpStatusCode: s.httpStatusCode,
        spanStatusCode: s.spanStatusCode,
      })),
      relevantLogs: [],
      platformEvents: [],
    },
    pointers: {
      traceRefs: [...new Set(spans.map((s) => s.traceId))],
      logRefs: [],
      metricRefs: [],
      platformLogRefs: [],
    },
  }
}
