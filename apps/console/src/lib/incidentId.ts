const INCIDENT_ID_RE = /^inc_[A-Za-z0-9_-]+$/;

export function parseIncidentId(value: unknown): string | undefined {
  return typeof value === "string" && INCIDENT_ID_RE.test(value) ? value : undefined;
}

export function encodeIncidentId(incidentId: string): string {
  return encodeURIComponent(incidentId);
}

export function formatShortIncidentId(incidentId: string): string {
  const normalized = incidentId.startsWith("inc_")
    ? incidentId.slice(4)
    : incidentId.replace(/^INC-/, "");
  return `INC-${normalized.toUpperCase()}`;
}
