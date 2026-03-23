import type { Page } from "@playwright/test";

const E2E_TOKEN = "e2e-test-token";

/**
 * Incident list shape used by E2E navigation helpers.
 */
interface E2EIncidentSummary {
  incidentId: string;
  diagnosisResult?: unknown;
}

async function listIncidents(page: Page): Promise<E2EIncidentSummary[]> {
  const t0 = Date.now();
  console.log("[E2E helper] listIncidents: sending request via page.request");
  const res = await page.request.get("/api/incidents?limit=20", {
    headers: { Authorization: `Bearer ${E2E_TOKEN}` },
    timeout: 10_000,
  });
  console.log(`[E2E helper] listIncidents: ${res.status()} (${Date.now() - t0}ms)`);
  if (!res.ok()) {
    throw new Error(`[E2E] listIncidents failed: ${res.status()} ${res.statusText()} — ${await res.text()}`);
  }
  const data = (await res.json()) as { items?: E2EIncidentSummary[] };
  if (!data.items) {
    throw new Error(`[E2E] listIncidents: response has no 'items' field — got: ${JSON.stringify(data).slice(0, 200)}`);
  }
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
