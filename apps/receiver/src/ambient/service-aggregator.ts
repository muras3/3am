import type { BufferedSpan } from './types.js'
import type { ServiceSurface, RecentActivity } from './types.js'
import { isAnomalous } from '../domain/anomaly-detector.js'

const TTL_MS = 300_000 // 5 minutes
const TREND_BUCKETS = 6
const BUCKET_MS = 60_000 // 1 minute

function isError(span: BufferedSpan): boolean {
  if (span.httpStatusCode !== undefined && span.httpStatusCode >= 500) return true
  if (span.httpStatusCode === 429) return true
  if (span.spanStatusCode === 2) return true
  if (span.exceptionCount > 0) return true
  return false
}

function computeP95(durations: number[]): number {
  if (durations.length === 0) return 0
  const sorted = [...durations].sort((a, b) => a - b)
  const idx = Math.ceil(sorted.length * 0.95) - 1
  return sorted[idx]
}

function computeHealth(errorRate: number, p95Ms: number): 'healthy' | 'degraded' | 'critical' {
  if (errorRate >= 0.05 || p95Ms >= 5000) return 'critical'
  if (errorRate >= 0.01 || p95Ms >= 2000) return 'degraded'
  return 'healthy'
}

function computeTrend(spans: BufferedSpan[], now: number): number[] {
  const buckets = new Array<number>(TREND_BUCKETS).fill(0)
  const windowStart = now - TREND_BUCKETS * BUCKET_MS

  for (const span of spans) {
    const offset = span.startTimeMs - windowStart
    if (offset < 0) continue
    const bucketIdx = Math.floor(offset / BUCKET_MS)
    if (bucketIdx >= 0 && bucketIdx < TREND_BUCKETS) {
      buckets[bucketIdx]++
    }
  }

  return buckets.map((count) => count / 60)
}

export function computeServices(spans: BufferedSpan[], now?: number): ServiceSurface[] {
  if (spans.length === 0) return []

  const t = now ?? Date.now()

  // Group by service
  const byService = new Map<string, BufferedSpan[]>()
  for (const span of spans) {
    const group = byService.get(span.serviceName)
    if (group) {
      group.push(span)
    } else {
      byService.set(span.serviceName, [span])
    }
  }

  const results: ServiceSurface[] = []
  for (const [name, serviceSpans] of byService) {
    const total = serviceSpans.length
    const errorCount = serviceSpans.filter(isError).length
    const errorRate = total > 0 ? errorCount / total : 0
    const p95Ms = computeP95(serviceSpans.map((s) => s.durationMs))
    const health = computeHealth(errorRate, p95Ms)
    const reqPerSec = total / (TTL_MS / 1000)
    const trend = computeTrend(serviceSpans, t)

    results.push({ name, health, reqPerSec, p95Ms, errorRate, trend })
  }

  return results
}

export function computeActivity(spans: BufferedSpan[], limit: number): RecentActivity[] {
  if (spans.length === 0) return []

  const sorted = [...spans].sort((a, b) => b.startTimeMs - a.startTimeMs)
  const sliced = sorted.slice(0, limit)

  return sliced.map((span) => ({
    ts: span.startTimeMs,
    service: span.serviceName,
    route: span.httpRoute ?? '',
    httpStatus: span.httpStatusCode,
    durationMs: span.durationMs,
    traceId: span.traceId,
    anomalous: isAnomalous(span),
  }))
}
