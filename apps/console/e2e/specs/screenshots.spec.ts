import { test, expect } from "@playwright/test";

const TOKEN = "e2e-test-token";

/**
 * Golden screenshot tests for receiver-served E2E.
 * Requires: `pnpm build` + `playwright.receiver-served.config.ts`
 *
 * To update snapshots after intentional UI changes:
 *   pnpm e2e:receiver-served --update-snapshots
 */

test("normal mode screenshot", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page).toHaveScreenshot("normal-mode.png", { maxDiffPixelRatio: 0.02 });
});

test("incident workspace screenshot", async ({ page }) => {
  // Fetch first seeded incident
  const res = await page.request.get("http://localhost:4319/api/incidents", {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const body = (await res.json()) as { items: Array<{ incidentId: string }> };
  const incidentId = body.items[0]?.incidentId;
  if (!incidentId) throw new Error("No seeded incidents found");

  await page.goto(`/?incidentId=${incidentId}`);
  // Wait for CSS transition to complete
  await page.waitForTimeout(600);
  await expect(page).toHaveScreenshot("incident-workspace.png", { maxDiffPixelRatio: 0.02 });
});

test("evidence studio screenshot", async ({ page }) => {
  const res = await page.request.get("http://localhost:4319/api/incidents", {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const body = (await res.json()) as { items: Array<{ incidentId: string }> };
  const incidentId = body.items[0]?.incidentId;
  if (!incidentId) throw new Error("No seeded incidents found");

  await page.goto(`/?incidentId=${incidentId}`);
  await page.waitForTimeout(600);
  await page.click("[data-testid=open-evidence-studio]");
  await expect(page.locator("[data-testid=proof-cards]")).toBeVisible();
  await expect(page).toHaveScreenshot("evidence-studio.png", { maxDiffPixelRatio: 0.02 });
});
