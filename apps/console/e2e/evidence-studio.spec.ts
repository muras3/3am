import { test, expect } from "@playwright/test";

/**
 * Evidence Studio E2E tests.
 *
 * Each test opens the first seeded incident's board and exercises the modal.
 * The EvidenceStudio component defaults to the "traces" tab on open.
 *
 * Tab display names (derived from EvidenceTabs.tsx):
 *   "metrics"       → "Metrics"
 *   "traces"        → "Traces"
 *   "logs"          → "Logs"
 *   "platform-logs" → "Platform logs"
 */
test.describe("Evidence Studio", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForURL(/[?&]incidentId=/);
    // Wait for the board to fully render before each test
    await expect(page.locator(".section-what")).toBeVisible();
  });

  test("opens Evidence Studio modal", async ({ page }) => {
    await page.click("button.btn-evidence");
    await expect(page.locator(".evidence-modal")).toBeVisible();
  });

  test("Traces tab shows waterfall rows (default tab)", async ({ page }) => {
    await page.click("button.btn-evidence");
    // Traces is the default tab — waterfall rows should already be visible
    await expect(page.locator(".wf-row").first()).toBeVisible();
  });

  test("Metrics tab shows empty-state message", async ({ page }) => {
    await page.click("button.btn-evidence");
    await page.click(".ev-tab:has-text('Metrics')");
    await expect(page.locator("text=No metrics data")).toBeVisible();
  });

  test("Logs tab shows empty state when no relevantLogs", async ({ page }) => {
    await page.click("button.btn-evidence");
    await page.click(".ev-tab:has-text('Logs')");
    // Seeded incident has relevantLogs: [] — empty state expected until /v1/logs ingest is active
    await expect(page.locator("text=No log record data")).toBeVisible();
  });

  test("Platform logs tab shows Plane column header", async ({ page }) => {
    await page.click("button.btn-evidence");
    await page.click(".ev-tab:has-text('Platform logs')");
    await expect(page.locator("text=Plane")).toBeVisible();
  });

  test("ESC key closes the modal", async ({ page }) => {
    await page.click("button.btn-evidence");
    await expect(page.locator(".evidence-modal")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".evidence-modal")).not.toBeVisible();
  });

  test("clicking the overlay backdrop closes the modal", async ({ page }) => {
    await page.click("button.btn-evidence");
    const modal = page.locator(".evidence-modal");
    await expect(modal).toBeVisible();
    // Click the overlay (parent of the modal) outside the modal bounds
    const overlay = page.locator(".overlay.show");
    const box = await overlay.boundingBox();
    if (box) {
      // Click in the top-left corner of the overlay, well outside the modal
      await page.mouse.click(box.x + 5, box.y + 5);
    }
    await expect(modal).not.toBeVisible();
  });

  test("Close button closes the modal", async ({ page }) => {
    await page.click("button.btn-evidence");
    await expect(page.locator(".evidence-modal")).toBeVisible();
    await page.click(".btn-close");
    await expect(page.locator(".evidence-modal")).not.toBeVisible();
  });
});
