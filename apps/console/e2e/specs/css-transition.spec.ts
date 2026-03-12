import { test, expect } from "@playwright/test";

/**
 * Phase 2 CSS transition gate tests.
 *
 * Verifies the in-place CSS transition shell:
 * - NormalSurface is shown at "/" when no incidents exist
 * - Incident workspace is shown at "/?incidentId=..."
 * - Both center divs are always in the DOM (never unmounted)
 * - Right rail expands when entering incident mode
 * - Legacy "/incidents/:id" URLs redirect to search-param form
 * - No transitions when prefers-reduced-motion: reduce is active
 */

import type { Page } from "@playwright/test";

/** Navigate to "/" with the incident list API mocked to return empty (forces normal mode). */
async function gotoNormalMode(page: Page) {
  await page.route("**/api/incidents*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [] }),
    }),
  );
  await page.goto("/");
  // Wait for React to render (no redirect since list is empty)
  await page.waitForTimeout(300);
}

test.describe("Phase 2 CSS transition shell", () => {
  test("/ shows NormalSurface when no incidents", async ({ page }) => {
    await gotoNormalMode(page);
    await expect(page.locator("[data-surface=normal]")).toBeVisible();
  });

  test("/?incidentId opens incident workspace", async ({ page }) => {
    await page.goto("/");
    // Auto-redirect fires when incidents are seeded
    await page.waitForURL(/[?&]incidentId=/, { timeout: 8000 });
    await expect(page.locator("[data-surface=incident]")).toBeVisible({ timeout: 6000 });
  });

  test("right rail expands to ~220px in incident mode", async ({ page }) => {
    await page.goto("/");
    await page.waitForURL(/[?&]incidentId=/);
    // Wait for the grid transition to complete (450ms + buffer)
    await page.waitForTimeout(600);
    const box = await page.locator(".right-rail").boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(215);
    expect(box!.width).toBeLessThanOrEqual(225);
  });

  test("center-normal and center-incident are always attached in normal mode", async ({
    page,
  }) => {
    await gotoNormalMode(page);
    await expect(page.locator(".center-normal")).toBeAttached();
    await expect(page.locator(".center-incident")).toBeAttached();
  });

  test("center-normal and center-incident are always attached in incident mode", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForURL(/[?&]incidentId=/);
    await expect(page.locator(".center-normal")).toBeAttached();
    await expect(page.locator(".center-incident")).toBeAttached();
  });

  test("legacy /incidents/:id URL redirects to /?incidentId=", async ({ page }) => {
    await page.goto("/incidents/any-id-123");
    await page.waitForURL(/[?&]incidentId=/, { timeout: 5000 });
    expect(page.url()).toMatch(/[?&]incidentId=/);
  });

  test("no transition when prefers-reduced-motion: reduce", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await gotoNormalMode(page);

    const duration = await page.locator(".center-normal").evaluate((el) =>
      getComputedStyle(el).transitionDuration,
    );
    // All transition-duration values should be "0s"
    expect(duration.split(",").every((d) => d.trim() === "0s")).toBe(true);
  });
});
