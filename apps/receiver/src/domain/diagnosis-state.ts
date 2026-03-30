import type { Incident } from "../storage/interface.js";

const DIAGNOSIS_LEASE_MS = 15 * 60_000;

export function hasActiveDiagnosisLease(incident: Incident): boolean {
  if (!incident.diagnosisDispatchedAt) return false;
  const claimedAt = new Date(incident.diagnosisDispatchedAt).getTime();
  if (!Number.isFinite(claimedAt)) return false;
  return claimedAt + DIAGNOSIS_LEASE_MS > Date.now();
}

export function classifyDiagnosisState(
  incident: Incident,
): "ready" | "pending" | "unavailable" {
  if (hasActiveDiagnosisLease(incident)) return "pending";
  if (incident.diagnosisResult) return "ready";
  return "unavailable";
}
