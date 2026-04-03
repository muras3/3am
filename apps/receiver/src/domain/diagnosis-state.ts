import type { Incident } from "../storage/interface.js";

const DIAGNOSIS_LEASE_MS = 15 * 60_000;

/** Grace period after incident creation before declaring diagnosis unavailable.
 *  Covers Queue delay + OTLP propagation time. */
const DIAGNOSIS_GRACE_MS = 90_000;

export function hasActiveDiagnosisLease(incident: Incident): boolean {
  if (!incident.diagnosisDispatchedAt) return false;
  const claimedAt = new Date(incident.diagnosisDispatchedAt).getTime();
  if (!Number.isFinite(claimedAt)) return false;
  return claimedAt + DIAGNOSIS_LEASE_MS > Date.now();
}

export function classifyDiagnosisState(
  incident: Incident,
): "ready" | "pending" | "unavailable" {
  // Active lease takes priority: a rerun may be in progress even if old diagnosisResult exists
  if (hasActiveDiagnosisLease(incident)) return "pending";
  if (incident.diagnosisResult) return "ready";
  // Within grace period after incident creation: diagnosis is expected but not yet dispatched
  const openedAt = new Date(incident.openedAt).getTime();
  if (Number.isFinite(openedAt) && openedAt + DIAGNOSIS_GRACE_MS > Date.now()) {
    return "pending";
  }
  return "unavailable";
}
