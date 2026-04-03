import type { Incident } from "../storage/interface.js";

const DIAGNOSIS_LEASE_MS = 15 * 60_000;

export function hasActiveDiagnosisLease(incident: Incident): boolean {
  if (!incident.diagnosisDispatchedAt) return false;
  const claimedAt = new Date(incident.diagnosisDispatchedAt).getTime();
  if (!Number.isFinite(claimedAt)) return false;
  return claimedAt + DIAGNOSIS_LEASE_MS > Date.now();
}

/** Returns true when diagnosisScheduledAt is set (diagnosis has been enqueued). */
export function hasScheduledDiagnosis(incident: Incident): boolean {
  return incident.diagnosisScheduledAt !== undefined && incident.diagnosisScheduledAt !== null;
}

export function classifyDiagnosisState(
  incident: Incident,
): "ready" | "pending" | "unavailable" {
  // 1. Active lease takes priority: a rerun may be in progress even if old diagnosisResult exists
  if (hasActiveDiagnosisLease(incident)) return "pending";
  // 2. Diagnosis result exists — ready
  if (incident.diagnosisResult) return "ready";
  // 3. Diagnosis has been scheduled/enqueued but not yet dispatched — pending
  if (hasScheduledDiagnosis(incident)) return "pending";
  // 4. No scheduled diagnosis and no result — unavailable
  return "unavailable";
}
