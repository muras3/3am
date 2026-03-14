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
import type { IncidentPacket, PlatformEvent } from "@3amoncall/core"
import { type ExtractedSpan, isAnomalous, SLOW_SPAN_THRESHOLD_MS } from "./anomaly-detector.js"
import { normalizeDependency } from "./formation.js"
import type { AnomalousSignal, IncidentRawState } from "../storage/interface.js"

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

function selectRepresentativeTraces(spans: ExtractedSpan[]): RepresentativeTrace[] {
  if (spans.length === 0) return []

  // Pre-sort all spans once: score desc, tie-break asc
  const scored = spans.slice().sort(compareByScore)

  // ------------------------------------------------------------------
  // Phase 1 — Top anomaly guarantee
  // ------------------------------------------------------------------
  // Take up to TOP_ANOMALY_GUARANTEE spans that have score > 0.
  const guaranteed: ExtractedSpan[] = []
  for (const span of scored) {
    if (guaranteed.length >= TOP_ANOMALY_GUARANTEE) break
    if (scoreSpan(span) > 0) {
      guaranteed.push(span)
    }
  }

  // Track route caps and service set; seed with Phase 1 results.
  const routeCaps: Record<string, number> = {}
  const serviceSet = new Set<string>()

  for (const span of guaranteed) {
    const key = `${span.serviceName}:${span.httpRoute ?? ""}`
    routeCaps[key] = (routeCaps[key] ?? 0) + 1
    serviceSet.add(span.serviceName)
  }

  // ------------------------------------------------------------------
  // Phase 2 — Diversity fill (greedy with dynamic service-diversity preference)
  // ------------------------------------------------------------------
  // At each step, prefer a span whose service has not yet been selected in
  // Phase 2 (dynamic, not a one-time partition). This prevents a high-score
  // service from consuming multiple Phase 2 slots before other services get
  // a chance, which is critical for cascade-spread coverage.
  // Fallback: if no unseen-service span is available within the route cap,
  // pick the best remaining span regardless of service.
  const guaranteedSet = new Set(guaranteed.map(tiebreakerKey))
  const remaining = scored.filter((s) => !guaranteedSet.has(tiebreakerKey(s)))

  const phase2Picks: ExtractedSpan[] = []
  const phase2ServiceSet = new Set<string>()   // services selected so far in Phase 2
  const phase2PickedKeys = new Set<string>()   // identity keys of picked spans
  const budget = MAX_REPRESENTATIVE_TRACES - guaranteed.length

  while (phase2Picks.length < budget) {
    let picked: ExtractedSpan | undefined

    // Pass 1: prefer span from a service not yet seen in Phase 2
    for (const span of remaining) {
      if (phase2PickedKeys.has(tiebreakerKey(span))) continue
      const key = `${span.serviceName}:${span.httpRoute ?? ""}`
      if ((routeCaps[key] ?? 0) >= MAX_ROUTE_DIVERSITY) continue
      if (!phase2ServiceSet.has(span.serviceName)) {
        picked = span
        break
      }
    }

    // Pass 2: no unseen-service available — take best remaining within route cap
    if (picked === undefined) {
      for (const span of remaining) {
        if (phase2PickedKeys.has(tiebreakerKey(span))) continue
        const key = `${span.serviceName}:${span.httpRoute ?? ""}`
        if ((routeCaps[key] ?? 0) >= MAX_ROUTE_DIVERSITY) continue
        picked = span
        break
      }
    }

    if (picked === undefined) break

    phase2Picks.push(picked)
    phase2PickedKeys.add(tiebreakerKey(picked))
    const routeKey = `${picked.serviceName}:${picked.httpRoute ?? ""}`
    routeCaps[routeKey] = (routeCaps[routeKey] ?? 0) + 1
    phase2ServiceSet.add(picked.serviceName)
  }

  // ------------------------------------------------------------------
  // Dependency injection
  // ------------------------------------------------------------------
  // Ensure at least one span with a peerService is present so the LLM
  // always sees external-dependency context.
  const selected: ExtractedSpan[] = [...guaranteed, ...phase2Picks]
  const hasDep = selected.some((s) => s.peerService !== undefined)

  if (!hasDep) {
    // Find the best (highest-score) dep span not already selected
    const selectedKeys = new Set(selected.map(tiebreakerKey))
    const depSpan = scored.find((s) => s.peerService !== undefined && !selectedKeys.has(tiebreakerKey(s)))

    if (depSpan !== undefined) {
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
        for (let i = selected.length - 1; i >= guaranteed.length; i--) {
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

export function rebuildPacket(
  incidentId: string,
  packetId: string,
  openedAt: string,
  rawState: IncidentRawState,
  existingEvidence?: { changedMetrics?: unknown[]; relevantLogs?: unknown[] },
  generation?: number,
  primaryService?: string,
): IncidentPacket {
  const { spans, anomalousSignals, platformEvents } = rawState

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
  const affectedDependencies = [
    ...new Set(
      spans.flatMap((s) => {
        const dep = normalizeDependency(s.peerService)
        return dep !== undefined ? [dep] : []
      }),
    ),
  ]

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

  // representativeTraces — 2-stage scoring + diversity selection (Plan 4 / B-2)
  const representativeTraces = selectRepresentativeTraces(spans)

  // pointers
  const traceRefs = [...new Set(spans.map((s) => s.traceId))]
  const platformLogRefs = platformEvents.map(buildPlatformLogRef)

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
      platformEvents,
    },
    pointers: {
      traceRefs,
      logRefs: [],
      metricRefs: [],
      platformLogRefs,
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
