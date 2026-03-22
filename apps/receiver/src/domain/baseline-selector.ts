/**
 * Baseline Selector — selects normal (expected) traces for comparison
 * with incident (observed) traces.
 *
 * 3-tier fallback:
 *   1. same_route  (httpRoute + service + peerService, min 5 normal spans)
 *   2. same_service (service-wide, min 10 normal spans)
 *   3. none         (no baseline available)
 */

import type { TelemetrySpan, TelemetryStoreDriver } from '../telemetry/interface.js'
import type { BaselineContext, BaselineSource } from '@3amoncall/core/schemas/curated-evidence'

// ── Public Types ────────────────────────────────────────────────────────

export interface BaselineQuery {
  incidentWindowStartMs: number
  incidentWindowEndMs: number
  primaryService: string
  httpRoute?: string
  peerService?: string
}

export interface BaselineResult {
  context: BaselineContext
  spans: TelemetrySpan[]
}

// ── Constants ───────────────────────────────────────────────────────────

const MIN_BASELINE_WINDOW_MS = 300_000 // 5 minutes
const BASELINE_MULTIPLIER = 4

const MIN_SAME_ROUTE_SPANS = 5
const MIN_SAME_SERVICE_SPANS = 10

const MAX_TRACES = 3

// ── Pure Helpers ────────────────────────────────────────────────────────

/** Compute the baseline (pre-incident) time window. */
export function computeBaselineWindow(
  incidentWindowStartMs: number,
  incidentWindowEndMs: number,
): { startMs: number; endMs: number } {
  const incidentDuration = incidentWindowEndMs - incidentWindowStartMs
  const lookback = Math.max(incidentDuration * BASELINE_MULTIPLIER, MIN_BASELINE_WINDOW_MS)
  return {
    startMs: incidentWindowStartMs - lookback,
    endMs: incidentWindowStartMs,
  }
}

/** Map sample count to confidence level. */
export function computeConfidence(
  sampleCount: number,
): 'high' | 'medium' | 'low' | 'unavailable' {
  if (sampleCount >= 30) return 'high'
  if (sampleCount >= 10) return 'medium'
  if (sampleCount >= 1) return 'low'
  return 'unavailable'
}

/** A span is "normal" when it has no error signals. */
function isNormalSpan(span: TelemetrySpan): boolean {
  const httpOk = span.httpStatusCode === undefined || span.httpStatusCode < 400
  const statusOk = span.spanStatusCode !== 2
  const noExceptions = span.exceptionCount === 0
  return httpOk && statusOk && noExceptions
}

/**
 * From a list of normal spans, select up to `MAX_TRACES` representative
 * traces closest to the median total duration.
 */
function selectRepresentativeTraces(spans: TelemetrySpan[]): TelemetrySpan[] {
  if (spans.length === 0) return []

  // Group by traceId
  const traceGroups = new Map<string, TelemetrySpan[]>()
  for (const span of spans) {
    const group = traceGroups.get(span.traceId)
    if (group) {
      group.push(span)
    } else {
      traceGroups.set(span.traceId, [span])
    }
  }

  // Compute total duration per trace
  const traceDurations: { traceId: string; totalDuration: number }[] = []
  for (const [traceId, group] of traceGroups) {
    const totalDuration = group.reduce((sum, s) => sum + s.durationMs, 0)
    traceDurations.push({ traceId, totalDuration })
  }

  // Compute median
  const sorted = [...traceDurations].sort((a, b) => a.totalDuration - b.totalDuration)
  const mid = Math.floor(sorted.length / 2)
  const midEntry = sorted[mid]
  const prevEntry = sorted[mid - 1]
  const median =
    sorted.length % 2 === 0
      ? ((prevEntry?.totalDuration ?? 0) + (midEntry?.totalDuration ?? 0)) / 2
      : (midEntry?.totalDuration ?? 0)

  // Sort by distance from median, pick top MAX_TRACES
  traceDurations.sort(
    (a, b) => Math.abs(a.totalDuration - median) - Math.abs(b.totalDuration - median),
  )
  const selectedTraceIds = new Set(
    traceDurations.slice(0, MAX_TRACES).map((t) => t.traceId),
  )

  // Return all spans belonging to selected traces
  return spans.filter((s) => selectedTraceIds.has(s.traceId))
}

// ── Main Entry ──────────────────────────────────────────────────────────

export async function selectBaseline(
  telemetryStore: TelemetryStoreDriver,
  query: BaselineQuery,
): Promise<BaselineResult> {
  const window = computeBaselineWindow(query.incidentWindowStartMs, query.incidentWindowEndMs)

  // Query all spans in the baseline window for the primary service
  const allSpans = await telemetryStore.querySpans({
    startMs: window.startMs,
    endMs: window.endMs,
    services: [query.primaryService],
  })

  // Filter to normal spans only
  const normalSpans = allSpans.filter(isNormalSpan)

  // ── Tier 1: same_route ──────────────────────────────────────────────
  if (query.httpRoute) {
    const routeSpans = normalSpans.filter((s) => {
      if (s.httpRoute !== query.httpRoute) return false
      if (query.peerService && s.peerService !== query.peerService) return false
      return true
    })

    if (routeSpans.length >= MIN_SAME_ROUTE_SPANS) {
      const selected = selectRepresentativeTraces(routeSpans)
      const source: BaselineSource = {
        kind: 'same_route',
        route: query.httpRoute,
        service: query.primaryService,
      }
      return {
        context: {
          windowStart: new Date(window.startMs).toISOString(),
          windowEnd: new Date(window.endMs).toISOString(),
          sampleCount: routeSpans.length,
          confidence: computeConfidence(routeSpans.length),
          source,
        },
        spans: selected,
      }
    }
  }

  // ── Tier 2: same_service ────────────────────────────────────────────
  if (normalSpans.length >= MIN_SAME_SERVICE_SPANS) {
    const selected = selectRepresentativeTraces(normalSpans)
    const source: BaselineSource = {
      kind: 'same_service',
      service: query.primaryService,
    }
    return {
      context: {
        windowStart: new Date(window.startMs).toISOString(),
        windowEnd: new Date(window.endMs).toISOString(),
        sampleCount: normalSpans.length,
        confidence: computeConfidence(normalSpans.length),
        source,
      },
      spans: selected,
    }
  }

  // ── Tier 3: none ────────────────────────────────────────────────────
  return {
    context: {
      windowStart: new Date(window.startMs).toISOString(),
      windowEnd: new Date(window.endMs).toISOString(),
      sampleCount: 0,
      confidence: 'unavailable',
      source: { kind: 'none' },
    },
    spans: [],
  }
}
