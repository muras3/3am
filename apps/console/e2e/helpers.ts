import type { Page } from "@playwright/test";

/**
 * Incident list shape used by E2E navigation helpers.
 * /api/incidents is not behind bearerAuth (ADR 0011) — same-origin console access.
 */
interface E2EIncidentSummary {
  incidentId: string;
  diagnosisResult?: unknown;
}

async function listIncidents(page: Page): Promise<E2EIncidentSummary[]> {
  const res = await page.request.get("/api/incidents?limit=20");
  const data = (await res.json()) as { items: E2EIncidentSummary[] };
  return data.items;
}

export async function getOpenIncidentCount(page: Page): Promise<number> {
  return (await listIncidents(page)).length;
}

export async function getFirstIncidentId(page: Page): Promise<string> {
  const incidents = await listIncidents(page);
  const firstDiagnosed = incidents.find((incident) => incident.diagnosisResult);
  if (!firstDiagnosed) {
    throw new Error("[E2E] No diagnosed incidents — run global-setup first");
  }
  return firstDiagnosed.incidentId;
}

/** Navigate to the first seeded incident's workspace (enters incident mode). */
export async function gotoFirstIncident(page: Page): Promise<string> {
  const incidentId = await getFirstIncidentId(page);
  await page.goto(`/?incidentId=${incidentId}`);
  return incidentId;
}
