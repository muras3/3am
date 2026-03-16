import { test, expect } from "@playwright/test";
import { gotoFirstIncident } from "./helpers.js";

/**
 * Evidence Studio v4 E2E tests.
 *
 * Evidence Studio is now a full-viewport page (not a modal overlay).
 * It uses .es-app layout with .es-tabs for tab navigation.
 *
 * Tab display names (derived from EvidenceTabs.tsx):
 *   "traces"   → "Traces"
 *   "metrics"  → "Metrics"
 *   "logs"     → "Logs"
 *   "platform" → "Platform"
 */
test.describe("Evidence Studio", () => {
  test.beforeEach(async ({ page }) => {
    await gotoFirstIncident(page);
    await expect(page.locator(".section-what")).toBeVisible();
  });

  test("opens Evidence Studio", async ({ page }) => {
    await page.click("button.btn-evidence");
    await expect(page.locator(".es-app")).toBeVisible();
  });

  test("Traces tab shows waterfall rows (default tab)", async ({ page }) => {
    await page.click("button.btn-evidence");
    await expect(page.locator(".es-app")).toBeVisible();
    // Traces is the default tab — waterfall rows should already be visible
    await expect(page.locator(".wf-row").first()).toBeVisible();
  });

  test("Metrics tab shows content or empty-state", async ({ page }) => {
    await page.click("button.btn-evidence");
    await page.click(".es-tab:has-text('Metrics')");
    // Seeded incident may have metrics or show empty state
    const hasMetrics = await page.locator(".metrics-stat-strip").isVisible().catch(() => false);
    const hasEmpty = await page.locator("text=No metric data available").isVisible().catch(() => false);
    expect(hasMetrics || hasEmpty).toBeTruthy();
  });

  test("Logs tab shows content or empty state", async ({ page }) => {
    await page.click("button.btn-evidence");
    await page.click(".es-tab:has-text('Logs')");
    const hasLogs = await page.locator(".log-row").first().isVisible().catch(() => false);
    const hasEmpty = await page.locator("text=No log").isVisible().catch(() => false);
    expect(hasLogs || hasEmpty).toBeTruthy();
  });

  test("Platform tab shows content or empty state", async ({ page }) => {
    await page.click("button.btn-evidence");
    await page.click(".es-tab:has-text('Platform')");
    const hasEvents = await page.locator(".pe-item").first().isVisible().catch(() => false);
    const hasEmpty = await page.locator("text=No platform events captured").isVisible().catch(() => false);
    expect(hasEvents || hasEmpty).toBeTruthy();
  });

  test("ESC key closes Evidence Studio", async ({ page }) => {
    await page.click("button.btn-evidence");
    await expect(page.locator(".es-app")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".es-app")).not.toBeVisible();
  });

  test("Close button closes Evidence Studio", async ({ page }) => {
    await page.click("button.btn-evidence");
    await expect(page.locator(".es-app")).toBeVisible();
    await page.click(".btn-close");
    await expect(page.locator(".es-app")).not.toBeVisible();
  });
});
