const INCIDENT_ID_RE = /^inc_[A-Za-z0-9_-]+$/;

export function parseIncidentId(value: unknown): string | undefined {
  return typeof value === "string" && INCIDENT_ID_RE.test(value) ? value : undefined;
}

export function encodeIncidentId(incidentId: string): string {
  return encodeURIComponent(incidentId);
}
