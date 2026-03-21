/**
 * evidence-counts.ts — canonical evidence counting shared across
 * incident-detail-extension and reasoning-structure-builder.
 *
 * Canonical rule (integration plan §5.1):
 *   traces    = unique traceId count
 *   traceErrors = error span count (status 500+ or spanStatus 2 or exception)
 *   logErrors   = ERROR/FATAL severity count
 */

import type { TelemetrySpan, TelemetryLog } from "../telemetry/interface.js";

export interface EvidenceCountResult {
  traceIds: number;
  traceErrors: number;
  logErrors: number;
}

export function computeEvidenceCounts(
  spans: TelemetrySpan[],
  logs: TelemetryLog[],
): EvidenceCountResult {
  const traceIds = new Set(spans.map((s) => s.traceId)).size;
  const traceErrors = spans.filter(
    (s) =>
      (s.httpStatusCode !== undefined && s.httpStatusCode >= 500) ||
      s.spanStatusCode === 2 ||
      s.exceptionCount > 0,
  ).length;
  const logErrors = logs.filter(
    (l) => l.severity === "ERROR" || l.severity === "FATAL",
  ).length;

  return { traceIds, traceErrors, logErrors };
}
