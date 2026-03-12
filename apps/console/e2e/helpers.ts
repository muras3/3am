import type { Page } from "@playwright/test";

/**
 * Fetch the first seeded incident ID from the receiver API.
 * /api/incidents is not behind bearerAuth (ADR 0011) — same-origin console access.
 */
export async function getFirstIncidentId(page: Page): Promise<string> {
  const res = await page.request.get("/api/incidents?limit=1");
  const data = (await res.json()) as { items: Array<{ incidentId: string }> };
  const first = data.items[0];
  if (!first) throw new Error("[E2E] No seeded incidents — run global-setup first");
  return first.incidentId;
}

/** Navigate to the first seeded incident's workspace (enters incident mode). */
export async function gotoFirstIncident(page: Page): Promise<string> {
  const incidentId = await getFirstIncidentId(page);
  await page.goto(`/?incidentId=${incidentId}`);
  return incidentId;
}
