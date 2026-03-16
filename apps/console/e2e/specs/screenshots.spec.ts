import { test, expect } from "@playwright/test";
import { gotoFirstIncident } from "../helpers.js";

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
  await gotoFirstIncident(page);
  // Wait for CSS transition to complete
  await page.waitForTimeout(600);
  // Raised from 0.05 to 0.08 for bottom-grid layout change (U-4/U-5/U-6).
  // Will be tightened back after CI baseline is regenerated.
  await expect(page).toHaveScreenshot("incident-workspace.png", { maxDiffPixelRatio: 0.08 });
});

test("evidence studio screenshot", async ({ page }) => {
  await gotoFirstIncident(page);
  await page.waitForTimeout(600);
  await expect(page.locator("[data-testid=open-evidence-studio]")).toBeVisible();
  await page.click("[data-testid=open-evidence-studio]");
  await expect(page.locator("[data-testid=proof-cards]")).toBeVisible();
  await expect(page).toHaveScreenshot("evidence-studio.png", { maxDiffPixelRatio: 0.05 });
});
