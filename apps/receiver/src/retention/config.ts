/**
 * Retention configuration — single source of truth for RETENTION_HOURS.
 *
 * RETENTION_HOURS controls how long telemetry data (spans, metrics, logs,
 * snapshots) and closed incidents are kept before lazy cleanup removes them.
 *
 * Default: 1 hour. Accepts positive integers only.
 */

const DEFAULT_RETENTION_HOURS = 1;

/**
 * Parse RETENTION_HOURS from environment.
 * Returns a positive integer; falls back to DEFAULT_RETENTION_HOURS on
 * unset, non-numeric, zero, negative, or non-integer values.
 */
export function getRetentionHours(): number {
  const raw = process.env["RETENTION_HOURS"];
  if (raw === undefined || raw === "") return DEFAULT_RETENTION_HOURS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    console.warn(
      `[retention] Invalid RETENTION_HOURS="${raw}", using default ${DEFAULT_RETENTION_HOURS}h`,
    );
    return DEFAULT_RETENTION_HOURS;
  }
  return parsed;
}

/**
 * Compute the retention cutoff Date.
 * Any data older than this should be eligible for deletion.
 */
export function getRetentionCutoff(nowMs?: number): Date {
  const now = nowMs ?? Date.now();
  return new Date(now - getRetentionHours() * 60 * 60 * 1000);
}

/** Minimum interval between cleanup runs (5 minutes). */
export const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
