import type { ExtractedSpan } from '../domain/anomaly-detector.js'

/** A span that has been buffered in the ambient read model, with ingestion timestamp. */
export type BufferedSpan = ExtractedSpan & {
  /** Unix milliseconds at which this span was ingested by the receiver. */
  ingestedAt: number
}

/** Aggregated surface metrics for a single service over the current observation window. */
export type ServiceSurface = {
  /** service.name */
  name: string
  health: 'healthy' | 'degraded' | 'critical'
  /**
   * Average requests per second over the full 5-minute TTL window (ADR 0029).
   * This is a smoothed window average, not an instantaneous rate.
   * Note: trend bucket values and reqPerSec may diverge for clock-skewed spans
   * where startTimeMs is older than the 6-minute trend window but ingestedAt is within TTL.
   */
  reqPerSec: number
  p95Ms: number
  /** Error rate in range 0.0–1.0 */
  errorRate: number
  /** 1-minute bucket req/s values, oldest first. Length 6. */
  trend: number[]
}

/** A single recent span activity entry for the live activity feed. */
export type RecentActivity = {
  /** startTimeMs of the span (Unix ms) */
  ts: number
  service: string
  /** http.route attribute value; empty string for non-HTTP spans */
  route: string
  /** HTTP status code; undefined for non-HTTP spans */
  httpStatus?: number
  durationMs: number
  traceId: string
  anomalous: boolean
}
