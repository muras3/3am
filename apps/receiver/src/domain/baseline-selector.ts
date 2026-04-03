/**
 * Baseline Selector — selects normal (expected) traces for comparison
 * with incident (observed) traces.
 *
 * 3-tier fallback (within same operation family only):
 *   1. exact_operation  (family + method, min 5 normal spans)
 *   2. same_operation_family (family only, relax method, min 3 normal spans)
 *   3. none             (no baseline available)
 */

import type { TelemetrySpan, TelemetryStoreDriver } from '../telemetry/interface.js'
import type { BaselineContext, BaselineSource } from '@3amoncall/core/schemas/curated-evidence'

// ── Operation Identity ──────────────────────────────────────────────────

export type OperationFamily =
  | { kind: 'route'; value: string }
  | { kind: 'span_name'; value: string }

export interface OperationIdentity {
  service: string
  family: OperationFamily
  method?: string
}

/** Derive an operation identity from a TelemetrySpan. */
export function deriveOperationIdentity(span: TelemetrySpan): OperationIdentity {
  return {
    service: span.serviceName,
    family: span.httpRoute
      ? { kind: 'route', value: span.httpRoute }
      : { kind: 'span_name', value: span.spanName },
    method: span.httpMethod,
  }
}

/**
 * Derive the dominant operation identity from anomalous spans.
 * Only considers spans belonging to primaryService to avoid picking
 * dependency/internal spans (e.g. Stripe calls) as the baseline target.
 * Ties are broken by key lexicographic order for stable results.
 */
export function deriveDominantOperation(
  spans: TelemetrySpan[],
  primaryService?: string,
): OperationIdentity | undefined {
  const filtered = primaryService
    ? spans.filter((s) => s.serviceName === primaryService)
    : spans
  if (filtered.length === 0) return undefined

  const counts = new Map<string, { identity: OperationIdentity; count: number; key: string }>()
  for (const span of filtered) {
    const id = deriveOperationIdentity(span)
    const key = `${id.family.kind}:${id.family.value}:${id.method ?? ''}`
    const entry = counts.get(key)
    if (entry) {
      entry.count++
    } else {
      counts.set(key, { identity: id, count: 1, key })
    }
  }

  let best: { identity: OperationIdentity; count: number; key: string } | undefined
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count || (entry.count === best.count && entry.key < best.key)) {
      best = entry
    }
  }
  return best?.identity
}

// ── Public Types ────────────────────────────────────────────────────────

export interface BaselineQuery {
  incidentWindowStartMs: number
  incidentWindowEndMs: number
  primaryService: string
  operation?: OperationIdentity
}

export interface BaselineResult {
  context: BaselineContext
  spans: TelemetrySpan[]
}

// ── Constants ───────────────────────────────────────────────────────────

const MIN_BASELINE_WINDOW_MS = 300_000 // 5 minutes
const BASELINE_MULTIPLIER = 4

const MIN_EXACT_OPERATION_SPANS = 5
const MIN_SAME_FAMILY_SPANS = 3

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

  if (query.operation) {
    const { family, method } = query.operation

    /** Check if a span matches the operation family. */
    const matchesFamily = (s: TelemetrySpan): boolean => {
      if (family.kind === 'route') return s.httpRoute === family.value
      return s.spanName === family.value
    }

    // ── Tier 1: exact_operation (family + method) ───────────────────
    const exactSpans = normalSpans.filter((s) =>
      matchesFamily(s) && (!method || s.httpMethod === method),
    )

    if (exactSpans.length >= MIN_EXACT_OPERATION_SPANS) {
      const selected = selectRepresentativeTraces(exactSpans)
      const source: BaselineSource = {
        kind: 'exact_operation',
        operation: family.value,
        service: query.primaryService,
      }
      return {
        context: {
          windowStart: new Date(window.startMs).toISOString(),
          windowEnd: new Date(window.endMs).toISOString(),
          sampleCount: exactSpans.length,
          confidence: computeConfidence(exactSpans.length),
          source,
        },
        spans: selected,
      }
    }

    // ── Tier 2: same_operation_family (family only, relax method) ───
    const familySpans = method ? normalSpans.filter(matchesFamily) : exactSpans

    if (familySpans.length >= MIN_SAME_FAMILY_SPANS) {
      const selected = selectRepresentativeTraces(familySpans)
      const source: BaselineSource = {
        kind: 'same_operation_family',
        operation: family.value,
        service: query.primaryService,
      }
      return {
        context: {
          windowStart: new Date(window.startMs).toISOString(),
          windowEnd: new Date(window.endMs).toISOString(),
          sampleCount: familySpans.length,
          confidence: computeConfidence(familySpans.length),
          source,
        },
        spans: selected,
      }
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
