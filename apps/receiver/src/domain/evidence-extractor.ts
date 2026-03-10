/**
 * Evidence extraction utilities for OTLP metrics and logs payloads.
 *
 * Extracts structured evidence from decoded OTLP bodies and determines
 * whether that evidence belongs to an existing open incident.
 *
 * Matching rules (aligned with shouldAttachToIncident in formation.ts):
 * - environment must match incident.packet.scope.environment
 * - service must be in primaryService ∪ affectedServices ∪ affectedDependencies
 * - 0 ≤ evidence.startTimeMs - incident.openedAt ≤ FORMATION_WINDOW_MS
 *
 * NOTE: no dedup; duplicates are acceptable (batch re-sends treated as repeated signals)
 */

import type { Incident } from '../storage/interface.js'
import { FORMATION_WINDOW_MS } from './formation.js'
import { isRecord, isArray, nanoToMs, getStringAttr } from './otlp-utils.js'

// ── Types ──────────────────────────────────────────────────────────────────

export type MetricEvidence = {
  name: string
  service: string
  environment: string
  startTimeMs: number
  /** Compressed datapoint:
   *  - histogram → { count, sum, min, max } (bucketCounts/explicitBounds excluded)
   *  - gauge/sum → { asDouble } or { asInt }
   */
  summary: unknown
}

export type LogEvidence = {
  service: string
  environment: string
  timestamp: string  // ISO string
  startTimeMs: number  // numeric epoch ms for evidence matching (= timestamp as number)
  severity: string   // "WARN" | "ERROR" | "FATAL" | "UNKNOWN"
  /** body.stringValue as-is; non-string body is JSON.stringify'd */
  body: string
  attributes: Record<string, unknown>
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Severity number → label. Returns null for levels below WARN (< 13). */
function severityLabel(num: unknown): string | null {
  const n = typeof num === 'number' ? num : typeof num === 'string' ? parseInt(num, 10) : NaN
  if (isNaN(n) || n < 13) return null
  if (n >= 21) return 'FATAL'
  if (n >= 17) return 'ERROR'
  if (n >= 13) return 'WARN'
  return null
}

/** Compress a histogram datapoint: keep count/sum/min/max, drop buckets. */
function compressHistogramDatapoint(dp: Record<string, unknown>): unknown {
  return {
    ...(dp['count'] !== undefined ? { count: dp['count'] } : {}),
    ...(dp['sum'] !== undefined ? { sum: dp['sum'] } : {}),
    ...(dp['min'] !== undefined ? { min: dp['min'] } : {}),
    ...(dp['max'] !== undefined ? { max: dp['max'] } : {}),
  }
}

/** Compress a gauge/sum datapoint: keep asDouble or asInt. */
function compressNumberDatapoint(dp: Record<string, unknown>): unknown {
  if (dp['asDouble'] !== undefined) return { asDouble: dp['asDouble'] }
  if (dp['asInt'] !== undefined) return { asInt: dp['asInt'] }
  return {}
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Extract metric evidence entries from a decoded OTLP ExportMetricsServiceRequest body.
 * Returns one MetricEvidence per (metric name × resource).
 */
export function extractMetricEvidence(body: unknown): MetricEvidence[] {
  if (!isRecord(body)) return []
  const resourceMetrics = body['resourceMetrics']
  if (!isArray(resourceMetrics)) return []

  const results: MetricEvidence[] = []

  for (const rm of resourceMetrics) {
    if (!isRecord(rm)) continue
    const attrs = isRecord(rm['resource']) ? rm['resource']['attributes'] : undefined
    const service = getStringAttr(attrs, 'service.name')
    const environment = getStringAttr(attrs, 'deployment.environment.name')
    if (!service) continue

    const scopeMetrics = rm['scopeMetrics']
    if (!isArray(scopeMetrics)) continue

    for (const sm of scopeMetrics) {
      if (!isRecord(sm)) continue
      const metrics = sm['metrics']
      if (!isArray(metrics)) continue

      for (const metric of metrics) {
        if (!isRecord(metric)) continue
        const name = typeof metric['name'] === 'string' ? metric['name'] : ''
        if (!name) continue

        // Determine first datapoint and startTimeMs
        let firstDp: Record<string, unknown> | null = null
        let summary: unknown = {}

        // histogram
        const hist = metric['histogram']
        if (isRecord(hist) && isArray(hist['dataPoints']) && hist['dataPoints'].length > 0) {
          firstDp = isRecord(hist['dataPoints'][0]) ? hist['dataPoints'][0] : null
          summary = firstDp ? compressHistogramDatapoint(firstDp) : {}
        }

        // gauge
        const gauge = metric['gauge']
        if (!firstDp && isRecord(gauge) && isArray(gauge['dataPoints']) && gauge['dataPoints'].length > 0) {
          firstDp = isRecord(gauge['dataPoints'][0]) ? gauge['dataPoints'][0] : null
          summary = firstDp ? compressNumberDatapoint(firstDp) : {}
        }

        // sum
        const sum = metric['sum']
        if (!firstDp && isRecord(sum) && isArray(sum['dataPoints']) && sum['dataPoints'].length > 0) {
          firstDp = isRecord(sum['dataPoints'][0]) ? sum['dataPoints'][0] : null
          summary = firstDp ? compressNumberDatapoint(firstDp) : {}
        }

        if (!firstDp) continue

        // startTimeMs: startTimeUnixNano → fallback timeUnixNano → drop
        const startTimeMs =
          nanoToMs(firstDp['startTimeUnixNano']) ??
          nanoToMs(firstDp['timeUnixNano'])
        if (startTimeMs === null) continue

        results.push({ name, service, environment, startTimeMs, summary })
      }
    }
  }

  return results
}

/**
 * Extract log evidence entries from a decoded OTLP ExportLogsServiceRequest body.
 * Only includes log records with severityNumber >= 13 (WARN and above).
 */
export function extractLogEvidence(body: unknown): LogEvidence[] {
  if (!isRecord(body)) return []
  const resourceLogs = body['resourceLogs']
  if (!isArray(resourceLogs)) return []

  const results: LogEvidence[] = []

  for (const rl of resourceLogs) {
    if (!isRecord(rl)) continue
    const attrs = isRecord(rl['resource']) ? rl['resource']['attributes'] : undefined
    const service = getStringAttr(attrs, 'service.name')
    const environment = getStringAttr(attrs, 'deployment.environment.name')
    if (!service) continue

    const scopeLogs = rl['scopeLogs']
    if (!isArray(scopeLogs)) continue

    for (const sl of scopeLogs) {
      if (!isRecord(sl)) continue
      const logRecords = sl['logRecords']
      if (!isArray(logRecords)) continue

      for (const lr of logRecords) {
        if (!isRecord(lr)) continue

        const severity = severityLabel(lr['severityNumber'])
        if (!severity) continue  // below WARN, skip

        // Drop records with no timestamp. A Date.now() fallback would cause spurious
        // incident attachment when openedAt is telemetry-anchored — so we drop instead.
        const startTimeMs = nanoToMs(lr['timeUnixNano']) ?? nanoToMs(lr['observedTimeUnixNano'])
        if (startTimeMs === null) continue
        const timestamp = new Date(startTimeMs).toISOString()

        // body: stringValue as-is, anything else → JSON.stringify
        const bodyVal = lr['body']
        let bodyStr: string
        if (isRecord(bodyVal) && typeof bodyVal['stringValue'] === 'string') {
          bodyStr = bodyVal['stringValue']
        } else {
          bodyStr = JSON.stringify(bodyVal ?? '')
        }

        // attributes: collect key-value pairs
        const attrMap: Record<string, unknown> = {}
        if (isArray(lr['attributes'])) {
          for (const a of lr['attributes']) {
            if (isRecord(a) && typeof a['key'] === 'string') {
              attrMap[a['key']] = a['value']
            }
          }
        }

        results.push({ service, environment, timestamp, startTimeMs, severity, body: bodyStr, attributes: attrMap })
      }
    }
  }

  return results
}

/**
 * Determine whether a piece of evidence should be attached to an existing open incident.
 *
 * Matching criteria (aligned with shouldAttachToIncident in formation.ts):
 * 1. incident is open
 * 2. environment matches
 * 3. service is primaryService OR in affectedServices OR in affectedDependencies
 * 4. 0 ≤ evidence.startTimeMs - incident.openedAt ≤ FORMATION_WINDOW_MS
 *
 * NOTE: primaryService is always in affectedServices (guaranteed by createPacket()),
 * but is checked explicitly to avoid relying on that internal invariant.
 */
export function shouldAttachEvidence(
  evidence: { service: string; environment: string; startTimeMs: number },
  incident: Incident,
): boolean {
  if (incident.status !== 'open') return false
  if (incident.packet.scope.environment !== evidence.environment) return false

  const { primaryService, affectedServices, affectedDependencies } = incident.packet.scope
  const inScope =
    primaryService === evidence.service ||
    affectedServices.includes(evidence.service) ||
    affectedDependencies.includes(evidence.service)
  if (!inScope) return false

  const openedAtMs = new Date(incident.openedAt).getTime()
  const delta = evidence.startTimeMs - openedAtMs
  return delta >= 0 && delta <= FORMATION_WINDOW_MS
}
