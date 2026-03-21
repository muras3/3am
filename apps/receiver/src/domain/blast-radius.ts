/**
 * blast-radius.ts — per-service error rate calculation from TelemetryStore spans.
 *
 * Computes blast radius entries for the incident detail extension.
 * Each service within the incident scope is classified as healthy/degraded/critical
 * based on its error rate (errors / total spans).
 *
 * Pure computation over TelemetryStore query results — no side effects beyond the query.
 */

import type { TelemetryStoreDriver, TelemetrySpan } from '../telemetry/interface.js'
import { buildIncidentQueryFilter } from '../telemetry/interface.js'
import type { TelemetryScope } from '../storage/interface.js'
import type { BlastRadiusEntry, BlastRadiusRollup } from '@3amoncall/core/schemas/incident-detail-extension'

// ── Thresholds ────────────────────────────────────────────────────────────

/** Error rate >= 5% → critical */
const CRITICAL_THRESHOLD = 0.05

/** Error rate >= 1% → degraded */
const DEGRADED_THRESHOLD = 0.01

// ── Public API ────────────────────────────────────────────────────────────

export async function computeBlastRadius(
  telemetryStore: TelemetryStoreDriver,
  telemetryScope: TelemetryScope,
): Promise<{ entries: BlastRadiusEntry[]; rollup: BlastRadiusRollup }> {
  const filter = buildIncidentQueryFilter(telemetryScope)
  const spans = await telemetryStore.querySpans(filter)

  // Group spans by serviceName
  const serviceGroups = groupSpansByService(spans)

  const allEntries: BlastRadiusEntry[] = []

  for (const [serviceName, serviceSpans] of serviceGroups) {
    const totalSpans = serviceSpans.length
    const errorCount = serviceSpans.filter(isErrorSpan).length
    const errorRate = totalSpans > 0 ? errorCount / totalSpans : 0

    const status = classifyStatus(errorRate)

    allEntries.push({
      targetId: `service:${serviceName}`,
      label: serviceName,
      status,
      impactMetric: 'error_rate' as const,
      impactValue: errorRate,
      displayValue: `${Math.round(errorRate * 100)}%`,
    })
  }

  // Sort by impactValue descending
  allEntries.sort((a, b) => b.impactValue - a.impactValue)

  // Separate degraded/critical from healthy
  const entries = allEntries.filter(e => e.status !== 'healthy')
  const healthyCount = allEntries.filter(e => e.status === 'healthy').length

  const rollup: BlastRadiusRollup = {
    healthyCount,
    label: `${healthyCount} other services ok`,
  }

  return { entries, rollup }
}

// ── Internal helpers ──────────────────────────────────────────────────────

/**
 * Determine if a span represents an error.
 *
 * Error criteria (matching anomaly detection conventions):
 * - HTTP status code >= 500 (server errors)
 * - HTTP status code === 429 (rate limiting)
 * - OTel span status code === 2 (ERROR)
 * - Exception count > 0
 */
function isErrorSpan(span: TelemetrySpan): boolean {
  if (span.httpStatusCode !== undefined && span.httpStatusCode >= 500) return true
  if (span.httpStatusCode === 429) return true
  if (span.spanStatusCode === 2) return true
  if (span.exceptionCount > 0) return true
  return false
}

function classifyStatus(errorRate: number): 'healthy' | 'degraded' | 'critical' {
  if (errorRate >= CRITICAL_THRESHOLD) return 'critical'
  if (errorRate >= DEGRADED_THRESHOLD) return 'degraded'
  return 'healthy'
}

function groupSpansByService(spans: TelemetrySpan[]): Map<string, TelemetrySpan[]> {
  const groups = new Map<string, TelemetrySpan[]>()
  for (const span of spans) {
    const group = groups.get(span.serviceName)
    if (group) {
      group.push(span)
    } else {
      groups.set(span.serviceName, [span])
    }
  }
  return groups
}
