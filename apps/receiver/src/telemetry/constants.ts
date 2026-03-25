/**
 * TelemetryStore scoring and operational constants.
 *
 * ADR 0032 Appendix A.6: concrete constant values are defined here as
 * exported const, tunable via validation scenarios. Structural changes
 * require an ADR amendment; constant value changes do not.
 */

// Retention constants moved to ../retention/config.ts (RETENTION_HOURS env var).

// ── Output size (ADR 0032 Decision 6) ────────────────────────────────────

/** Maximum changed metrics included in an incident packet. */
export const MAX_CHANGED_METRICS = 15

/** Maximum relevant logs included in an incident packet. */
export const MAX_RELEVANT_LOGS = 20

/** Maximum trace refs in packet pointers. */
export const MAX_TRACE_REFS = 30

// ── Diversity fill ───────────────────────────────────────────────────────

/** Number of top-scoring metrics guaranteed in output (not replaceable). */
export const METRIC_TOP_GUARANTEE = 3

/** Number of top-scoring logs guaranteed in output (not replaceable). */
export const LOG_TOP_GUARANTEE = 3

/** Maximum metrics per service in diversity fill. */
export const METRIC_MAX_PER_SERVICE = 5

/** Maximum logs per service in diversity fill. */
export const LOG_MAX_PER_SERVICE = 5

// ── Metrics scoring ──────────────────────────────────────────────────────

/**
 * Metric class weights by OTel semantic convention pattern.
 * Higher weight = more important during incident triage.
 */
export const METRIC_CLASS_WEIGHTS: Record<string, number> = {
  error_rate: 1.0,
  latency: 0.8,
  throughput: 0.6,
  resource: 0.4,
}

/** Baseline window = incident window * this multiplier (Netdata approach). */
export const BASELINE_MULTIPLIER = 4

/** Minimum baseline datapoints required for z-score calculation. */
export const MIN_BASELINE_DATAPOINTS = 3

/** z-score threshold for anomaly flag (Booking.com practice). */
export const ANOMALY_Z_THRESHOLD = 3.0

/** Bonus score for high Spearman correlation with anomalous signals. */
export const SPEARMAN_BONUS = 2.0

// ── Logs scoring ─────────────────────────────────────────────────────────

/**
 * Severity weights aligned with OTel SeverityNumber ranges.
 * FATAL(21-24)=3.0, ERROR(17-20)=2.0, WARN(13-16)=1.0
 */
export const LOG_SEVERITY_WEIGHTS: Record<string, number> = {
  FATAL: 3.0,
  ERROR: 2.0,
  WARN: 1.0,
}

/** Temporal decay lambda (per second) for log scoring. */
export const TEMPORAL_LAMBDA = 0.001

/** Bonus when log traceId matches an anomalous span traceId. */
export const TRACE_CORRELATION_BONUS = 2.0

/** Bonus when log body contains a diagnostic keyword. */
export const KEYWORD_BONUS = 1.0

/** Diagnostic keywords that indicate actionable log entries. */
export const LOG_KEYWORDS = [
  'timeout',
  'connection refused',
  'rate limit',
  'OOM',
  'circuit breaker',
  'deadline exceeded',
  'pool exhausted',
]
