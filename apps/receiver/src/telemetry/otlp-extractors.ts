/**
 * OTLP → TelemetryStore row extraction functions.
 *
 * Parallel to evidence-extractor.ts but outputs TelemetryStore types.
 * Key differences:
 * - extractTelemetryMetrics: extracts ALL datapoints (not just first)
 * - extractTelemetryLogs: preserves severityNumber, traceId, spanId, bodyHash
 *
 * These extractors do NOT modify existing evidence-extractor.ts or core schemas.
 */

import type { TelemetryMetric, TelemetryLog } from './interface.js'
import { computeBodyHash } from './body-hash.js'
import {
  isRecord,
  isArray,
  nanoToMs,
  normalizeIdToHex,
  resolveResourceServiceName,
  resolveResourceEnvironment,
  resolveEffectiveBody,
} from '../domain/otlp-utils.js'

// ── Helpers ────────────────────────────────────────────────────────────────

/** Extract the OTLP attributes array from a resource entry. */
function getResourceAttrs(entry: Record<string, unknown>): unknown {
  return isRecord(entry['resource']) ? entry['resource']['attributes'] : undefined
}

/** Compress a histogram datapoint: keep count/sum/min/max, drop buckets. */
function compressHistogramDatapoint(dp: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(dp['count'] !== undefined ? { count: dp['count'] } : {}),
    ...(dp['sum'] !== undefined ? { sum: dp['sum'] } : {}),
    ...(dp['min'] !== undefined ? { min: dp['min'] } : {}),
    ...(dp['max'] !== undefined ? { max: dp['max'] } : {}),
  }
}

/** Compress a gauge/sum datapoint: keep asDouble or asInt. */
function compressNumberDatapoint(dp: Record<string, unknown>): Record<string, unknown> {
  if (dp['asDouble'] !== undefined) return { asDouble: dp['asDouble'] }
  if (dp['asInt'] !== undefined) return { asInt: dp['asInt'] }
  return {}
}

/** Severity number → label. Returns null for levels below WARN (< 13). */
function severityLabel(num: unknown): string | null {
  const n = typeof num === 'number' ? num : typeof num === 'string' ? parseInt(num, 10) : NaN
  if (isNaN(n) || n < 13) return null
  if (n >= 21) return 'FATAL'
  if (n >= 17) return 'ERROR'
  return 'WARN'
}

/** Parse severityNumber from unknown value, returns NaN on failure. */
function parseSeverityNumber(num: unknown): number {
  if (typeof num === 'number') return num
  if (typeof num === 'string') return parseInt(num, 10)
  return NaN
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Extract TelemetryMetric rows from a decoded OTLP ExportMetricsServiceRequest body.
 *
 * Unlike extractMetricEvidence which takes only dataPoints[0], this function
 * iterates ALL datapoints per metric, emitting one TelemetryMetric row per datapoint.
 * This enables z-score baseline comparison and Spearman correlation in scoring.
 */
export function extractTelemetryMetrics(body: unknown): TelemetryMetric[] {
  if (!isRecord(body)) return []
  const resourceMetrics = body['resourceMetrics']
  if (!isArray(resourceMetrics)) return []

  const now = Date.now()
  const results: TelemetryMetric[] = []

  for (const rm of resourceMetrics) {
    if (!isRecord(rm)) continue
    const attrs = getResourceAttrs(rm)
    const service = resolveResourceServiceName(attrs)
    const environment = resolveResourceEnvironment(attrs)

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

        // Collect datapoints from all metric types: histogram, gauge, sum
        type DpEntry = { dp: Record<string, unknown>; compress: (dp: Record<string, unknown>) => Record<string, unknown> }
        const dataPointEntries: DpEntry[] = []

        const hist = metric['histogram']
        if (isRecord(hist) && isArray(hist['dataPoints'])) {
          for (const dp of hist['dataPoints']) {
            if (isRecord(dp)) dataPointEntries.push({ dp, compress: compressHistogramDatapoint })
          }
        }

        const gauge = metric['gauge']
        if (isRecord(gauge) && isArray(gauge['dataPoints'])) {
          for (const dp of gauge['dataPoints']) {
            if (isRecord(dp)) dataPointEntries.push({ dp, compress: compressNumberDatapoint })
          }
        }

        const sum = metric['sum']
        if (isRecord(sum) && isArray(sum['dataPoints'])) {
          for (const dp of sum['dataPoints']) {
            if (isRecord(dp)) dataPointEntries.push({ dp, compress: compressNumberDatapoint })
          }
        }

        // Emit one TelemetryMetric per datapoint
        for (const { dp, compress } of dataPointEntries) {
          const startTimeMs =
            nanoToMs(dp['timeUnixNano']) ??
            nanoToMs(dp['startTimeUnixNano'])
          if (startTimeMs === null) continue

          const summary = compress(dp)

          results.push({
            service,
            environment,
            name,
            startTimeMs,
            summary,
            ingestedAt: now,
          })
        }
      }
    }
  }

  return results
}

/**
 * Extract TelemetryLog rows from a decoded OTLP ExportLogsServiceRequest body.
 *
 * Unlike extractLogEvidence, this function additionally extracts:
 * - severityNumber (raw number, not just label)
 * - traceId / spanId (with base64→hex normalization for protobuf transport)
 * - bodyHash (for dedup grouping)
 *
 * Async due to computeBodyHash using Web Crypto API.
 */
export async function extractTelemetryLogs(body: unknown): Promise<TelemetryLog[]> {
  if (!isRecord(body)) return []
  const resourceLogs = body['resourceLogs']
  if (!isArray(resourceLogs)) return []

  const now = Date.now()

  // First pass: collect all valid log records with their fields
  type PendingLog = Omit<TelemetryLog, 'bodyHash'> & { rawBody: string }
  const pending: PendingLog[] = []

  for (const rl of resourceLogs) {
    if (!isRecord(rl)) continue
    const attrs = getResourceAttrs(rl)
    const service = resolveResourceServiceName(attrs)
    const environment = resolveResourceEnvironment(attrs)

    const scopeLogs = rl['scopeLogs']
    if (!isArray(scopeLogs)) continue

    for (const sl of scopeLogs) {
      if (!isRecord(sl)) continue
      const logRecords = sl['logRecords']
      if (!isArray(logRecords)) continue

      for (const lr of logRecords) {
        if (!isRecord(lr)) continue

        const sevNum = parseSeverityNumber(lr['severityNumber'])
        let severity = severityLabel(sevNum)
        if (!severity) {
          // Fallback for platforms (e.g. CF Observability) that omit severityNumber
          // (absent or 0) but populate severityText. Only activate when severityNumber
          // was not a valid positive number — a positive number below WARN is intentionally filtered.
          const hasExplicitNumber = !isNaN(sevNum) && sevNum > 0
          if (hasExplicitNumber) {
            continue  // explicit low severity (e.g. DEBUG), skip
          }
          const sevText = typeof lr['severityText'] === 'string' ? lr['severityText'].toUpperCase() : ''
          if (sevText.startsWith('FATAL')) severity = 'FATAL'
          else if (sevText.startsWith('ERROR')) severity = 'ERROR'
          else if (sevText.startsWith('WARN')) severity = 'WARN'
          else continue  // no usable severity, skip
        }

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

        // Synthesize body from attributes when body is empty or trivial (pino structured logs)
        const effectiveBody = resolveEffectiveBody(bodyStr, attrMap)

        // traceId/spanId: normalize to hex (handles both JSON hex and protobuf base64)
        const traceId = normalizeIdToHex(lr['traceId']) || undefined
        const spanId = normalizeIdToHex(lr['spanId']) || undefined

        pending.push({
          service,
          environment,
          timestamp,
          startTimeMs,
          severity,
          severityNumber: sevNum,
          body: effectiveBody,
          attributes: attrMap,
          traceId,
          spanId,
          ingestedAt: now,
          rawBody: effectiveBody,
        })
      }
    }
  }

  // Batch compute bodyHash via Promise.all
  const hashes = await Promise.all(pending.map(p => computeBodyHash(p.rawBody)))

  const results: TelemetryLog[] = pending.map((p, i) => {
    const { rawBody: _rawBody, ...rest } = p
    return { ...rest, bodyHash: hashes[i] ?? '' }
  })

  return results
}
