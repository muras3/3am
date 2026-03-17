/**
 * packetizer.ts — Incident packet builder
 *
 * ## representativeTraces selection algorithm (Plan 4 / B-2)
 *
 * ### Design rationale
 * The previous `spans.slice(0, 10)` approach was purely arrival-order based,
 * which meant high-signal anomalous spans arriving late (e.g. a Stripe 429
 * surfaced after a burst of normal spans) would be silently dropped. This
 * caused LLM diagnosis to miss the key causal evidence.
 *
 * ### 2-stage approach
 * Phase 1 — Top anomaly guarantee:
 *   Score every span, take the top TOP_ANOMALY_GUARANTEE (=3) spans with
 *   score > 0. These are always included regardless of route/service caps.
 *   This ensures the most critical signals are never dropped.
 *
 * Phase 2 — Diversity fill (greedy, dynamic service preference):
 *   Fill the remaining budget (up to MAX_REPRESENTATIVE_TRACES=10) from
 *   the remaining scored spans. At each step, a span from a service not
 *   yet selected in Phase 2 is preferred over same-service spans, evaluated
 *   dynamically as the selection grows (not a one-time static partition).
 *   A per-route cap of MAX_ROUTE_DIVERSITY=3 prevents a single hot route
 *   from monopolising slots.
 *
 * ### Dependency injection
 *   If no selected span has a peerService, inject one external-dependency
 *   span so the LLM always sees at least one external context. Phase 1
 *   guaranteed spans are never displaced.
 *
 * ### Trade-offs
 * - Phase 1 cap at 3 is intentionally small so Phase 2 still has budget
 *   for service diversity. Raising TOP_ANOMALY_GUARANTEE reduces diversity.
 * - Route cap (3) prevents a single flapping route from consuming all slots.
 * - Dependency injection is best-effort: if all budget is consumed by Phase 1
 *   guaranteed spans alone and there is no room, injection is skipped.
 * - Tie-break by `traceId + spanId` lex ensures determinism across restarts
 *   and shuffled input orderings.
 */

import { randomUUID } from "crypto"
import type { IncidentPacket, PlatformEvent, RelevantLog } from "@3amoncall/core"
import { type ExtractedSpan, isAnomalous, SLOW_SPAN_THRESHOLD_MS } from "./anomaly-detector.js"
import { normalizeDependency } from "./formation.js"
import type { AnomalousSignal, TelemetryScope, InitialMembership } from "../storage/interface.js"
import { spanMembershipKey } from "../storage/interface.js"
import { diversityFill } from "../telemetry/scoring/diversity-fill.js"

// ---------------------------------------------------------------------------
// Exported constants (used in tests and future tunability)
// ---------------------------------------------------------------------------

/** Maximum number of representative traces in a packet */
export const MAX_REPRESENTATIVE_TRACES = 10

/**
 * Number of highest-score spans guaranteed in Phase 1.
 * These are included regardless of route/service caps.
 */
export const TOP_ANOMALY_GUARANTEE = 3

/**
 * Maximum spans per `${serviceName}:${httpRoute}` key in Phase 2.
 * Prevents a single hot route from monopolising all slots.
 */
export const MAX_ROUTE_DIVERSITY = 3

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type RepresentativeTrace = {
  traceId: string
  spanId: string
  serviceName: string
  durationMs: number
  httpStatusCode?: number
  spanStatusCode: number
}

// ---------------------------------------------------------------------------
// Scoring helper
// ---------------------------------------------------------------------------

/**
 * Compute an integer anomaly score for a span.
 * Higher score = more diagnostic value.
 * Multiple conditions are cumulative.
 */
function scoreSpan(span: ExtractedSpan): number {
  let score = 0
  if (span.httpStatusCode !== undefined && span.httpStatusCode >= 500) score += 3
  if (span.httpStatusCode === 429) score += 3
  if (span.exceptionCount > 0) score += 2
  if (span.spanStatusCode === 2) score += 2
  if (span.durationMs > SLOW_SPAN_THRESHOLD_MS) score += 1
  if (span.peerService !== undefined) score += 1
  return score
}

/**
 * Tie-break key: deterministic ordering when scores are equal.
 * Uses `traceId:spanId` (colon-delimited) to avoid concatenation collisions
 * when traceId/spanId strings have variable lengths.
 */
function tiebreakerKey(span: ExtractedSpan): string {
  return `${span.traceId}:${span.spanId}`
}

/**
 * Sort comparator: descending score, then ascending tie-break key.
 */
function compareByScore(a: ExtractedSpan, b: ExtractedSpan): number {
  const scoreDiff = scoreSpan(b) - scoreSpan(a)
  if (scoreDiff !== 0) return scoreDiff
  return tiebreakerKey(a).localeCompare(tiebreakerKey(b))
}

// ---------------------------------------------------------------------------
// Signal severity derivation
// ---------------------------------------------------------------------------

/**
 * Derive a severity level for an incident based on the anomalous signals,
 * log evidence, and the number of affected services.
 *
 * Scoring rules:
 *  - Signal types are deduplicated (Set-based, not count-based)
 *  - Any http_5xx signal present adds 4 pts (once, regardless of distinct 5xx codes)
 *  - http_429 adds 3 pts
 *  - exception / span_error each add 2 pts
 *  - slow_span adds 1 pt
 *  - FATAL log adds 3 pts; ERROR log adds 1 pt
 *  - >2 affected services adds 2 pts; exactly 2 adds 1 pt
 *
 * Thresholds: ≥6 → critical, ≥3 → high, ≥1 → medium, 0 → low
 */
export function deriveSignalSeverity(
  anomalousSignals: AnomalousSignal[],
  logEvidence: RelevantLog[],
  affectedServicesCount: number,
): "critical" | "high" | "medium" | "low" {
  let score = 0

  const signalTypes = new Set(anomalousSignals.map((s) => s.signal))

  // Span-derived signals — 5xx is scored once regardless of how many distinct codes appear
  let has5xx = false
  for (const sig of signalTypes) {
    if (sig.startsWith("http_5")) has5xx = true
    else if (sig === "http_429") score += 3
    else if (sig === "exception") score += 2
    else if (sig === "span_error") score += 2
    else if (sig === "slow_span") score += 1
  }
  if (has5xx) score += 4

  // Log-derived signals (check by severity string)
  const logSeverities = new Set(logEvidence.map((l) => l.severity.toUpperCase()))
  if (logSeverities.has("FATAL")) score += 3
  if (logSeverities.has("ERROR")) score += 1

  // Breadth indicator
  if (affectedServicesCount > 2) score += 2
  else if (affectedServicesCount === 2) score += 1

  if (score >= 6) return "critical"
  if (score >= 3) return "high"
  if (score >= 1) return "medium"
  return "low"
}

// ---------------------------------------------------------------------------
// 2-stage representative traces selection
// ---------------------------------------------------------------------------

function toRepresentativeTrace(span: ExtractedSpan): RepresentativeTrace {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    serviceName: span.serviceName,
    durationMs: span.durationMs,
    httpStatusCode: span.httpStatusCode,
    spanStatusCode: span.spanStatusCode,
  }
}

export function selectRepresentativeTraces(spans: ExtractedSpan[]): RepresentativeTrace[] {
  if (spans.length === 0) return []

  // Pre-sort all spans once: score desc, tie-break asc
  const scored = spans.slice().sort(compareByScore)

  // ------------------------------------------------------------------
  // Phase 1 + 2 + 3 — Generic diversity fill
  // ------------------------------------------------------------------
  const selected = diversityFill(scored, {
    maxItems: MAX_REPRESENTATIVE_TRACES,
    topGuarantee: TOP_ANOMALY_GUARANTEE,
    getScore: scoreSpan,
    getServiceKey: (s) => s.serviceName,
    getDiversityKey: (s) => `${s.serviceName}:${s.httpRoute ?? ""}`,
    maxPerDiversityKey: MAX_ROUTE_DIVERSITY,
    getIdentityKey: tiebreakerKey,
  })

  // ------------------------------------------------------------------
  // Dependency injection (trace-specific post-processing)
  // ------------------------------------------------------------------
  // Ensure at least one span with a peerService is present so the LLM
  // always sees external-dependency context.
  const hasDep = selected.some((s) => s.peerService !== undefined)

  if (!hasDep) {
    // Find the best (highest-score) dep span not already selected
    const selectedKeys = new Set(selected.map(tiebreakerKey))
    const depSpan = scored.find((s) => s.peerService !== undefined && !selectedKeys.has(tiebreakerKey(s)))

    if (depSpan !== undefined) {
      // Determine where Phase 1 ends: count of guaranteed items (topGuarantee with score > 0)
      let guaranteedCount = 0
      for (const item of scored) {
        if (guaranteedCount >= TOP_ANOMALY_GUARANTEE) break
        if (scoreSpan(item) > 0) guaranteedCount++
      }
      const phase2Start = Math.min(guaranteedCount, selected.length)
      const phase2Picks = selected.slice(phase2Start)

      // Injection candidates are Phase 2 picks only; guaranteed are untouchable.
      if (phase2Picks.length === 0) {
        // Case 3/4: no Phase 2 picks
        if (selected.length < MAX_REPRESENTATIVE_TRACES) {
          // Case 3: room to append
          selected.push(depSpan)
        }
        // Case 4: guaranteed alone filled MAX — skip
      } else {
        // Try to find a score=0 Phase 2 pick (Case 1)
        let replacedIdx = -1
        for (let i = selected.length - 1; i >= phase2Start; i--) {
          if (scoreSpan(selected[i]) === 0) {
            replacedIdx = i
            break
          }
        }

        if (replacedIdx !== -1) {
          // Case 1: replace the last score=0 Phase 2 span
          selected[replacedIdx] = depSpan
        } else {
          // Case 2: all Phase 2 picks have score > 0 — replace the last one
          selected[selected.length - 1] = depSpan
        }
      }
    }
  }

  return selected.map(toRepresentativeTrace)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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

/**
 * Deduplicate trigger signals by signal+entity key, keeping the earliest firstSeenAt per group.
 */
export function deduplicateTriggerSignals(
  signals: AnomalousSignal[],
): Array<{ signal: string; firstSeenAt: string; entity: string }> {
  const groupMap = new Map<string, { signal: string; firstSeenAt: string; entity: string }>()
  for (const sig of signals) {
    const key = `${sig.signal}|${sig.entity}`
    const existing = groupMap.get(key)
    if (!existing || sig.firstSeenAt < existing.firstSeenAt) {
      groupMap.set(key, { signal: sig.signal, firstSeenAt: sig.firstSeenAt, entity: sig.entity })
    }
  }
  return [...groupMap.values()]
}

export function buildPlatformLogRef(event: PlatformEvent): string {
  return event.eventId ?? `${event.timestamp}:${event.eventType}:${event.service ?? event.provider ?? "global"}`
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

/**
 * Create an initial incident packet and membership data from a batch of spans.
 *
 * Returns `{ packet, initialMembership }` so the caller can persist both
 * atomically via `storage.createIncident(packet, initialMembership)`.
 *
 * No longer depends on IncidentRawState — builds directly from spans.
 */
export function createPacket(
  incidentId: string,
  openedAt: string,
  spans: ExtractedSpan[],
  primaryService?: string,
): { packet: IncidentPacket; initialMembership: InitialMembership } {
  const resolvedPrimaryService = primaryService ?? selectPrimaryService(spans)
  const anomalousSpans = spans.filter(isAnomalous)
  const anomalousSignals = buildAnomalousSignals(anomalousSpans)

  // window
  const windowStart = Math.min(...spans.map((s) => s.startTimeMs))
  const windowEnd = Math.max(...spans.map((s) => s.startTimeMs + s.durationMs))
  const firstAnomalousSpan = anomalousSpans[0]
  const windowDetect = firstAnomalousSpan ? firstAnomalousSpan.startTimeMs : windowStart

  // scope
  const environment = spans[0]?.environment ?? "unknown"
  const affectedServices = [...new Set(spans.map((s) => s.serviceName))]
  const affectedRoutes = [...new Set(spans.flatMap((s) => (s.httpRoute ? [s.httpRoute] : [])))]
  const affectedDependencies = [
    ...new Set(
      spans.flatMap((s) => {
        const dep = normalizeDependency(s.peerService)
        return dep !== undefined ? [dep] : []
      }),
    ),
  ]
  const signalSeverity = deriveSignalSeverity(anomalousSignals, [], affectedServices.length)

  // triggerSignals: dedup by signal+entity, keep earliest firstSeenAt per group
  const triggerSignals = deduplicateTriggerSignals(anomalousSignals)

  // representativeTraces — 2-stage scoring + diversity selection (Plan 4 / B-2)
  const representativeTraces = selectRepresentativeTraces(spans)

  // pointers
  const traceRefs = [...new Set(spans.map((s) => s.traceId))]

  const packetId = randomUUID()
  const packet: IncidentPacket = {
    schemaVersion: "incident-packet/v1alpha1",
    packetId,
    incidentId,
    openedAt,
    status: "open",
    generation: 1,
    signalSeverity,
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
      changedMetrics: [],
      representativeTraces,
      relevantLogs: [],
      platformEvents: [],
    },
    pointers: {
      traceRefs,
      logRefs: [],
      metricRefs: [],
      platformLogRefs: [],
    },
  }

  // Build initial membership for atomic persistence
  const spanIds = spans.map((s) => spanMembershipKey(s.traceId, s.spanId))
  const memberServices = [...new Set(spans.map((s) => s.serviceName))]
  const dependencyServices = [
    ...new Set(
      spans.flatMap((s) => {
        const dep = normalizeDependency(s.peerService)
        return dep !== undefined ? [dep] : []
      }),
    ),
  ]

  const telemetryScope: TelemetryScope = {
    windowStartMs: windowStart,
    windowEndMs: windowEnd,
    detectTimeMs: windowDetect,
    environment,
    memberServices,
    dependencyServices,
  }

  const initialMembership: InitialMembership = {
    telemetryScope,
    spanMembership: spanIds,
    anomalousSignals,
  }

  return { packet, initialMembership }
}
