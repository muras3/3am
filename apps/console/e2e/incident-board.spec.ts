import { test, expect } from "@playwright/test";
import { gotoFirstIncident } from "./helpers.js";

/**
 * Tests that the IncidentBoard renders correctly for each seeded incident.
 *
 * The seed produces 5 incidents with diagnosis results. We navigate to each via
 * the LeftRail and verify the essential board sections are present.
 */
test.describe("IncidentBoard", () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to first incident — loads all 5 in the rail (incident mode)
    await gotoFirstIncident(page);
    // Wait until the list is fully populated
    await expect(page.locator(".incident-item")).toHaveCount(5);
  });

  for (let index = 0; index < 5; index++) {
    test(`incident ${index + 1}: board renders What Happened and Immediate Action`, async ({
      page,
    }) => {
      const items = page.locator(".incident-item");
      await items.nth(index).click();
      await expect(page.locator(".section-what")).toBeVisible();
      await expect(page.locator(".section-action")).toBeVisible();
    });

    test(`incident ${index + 1}: Open Evidence Studio button is visible`, async ({
      page,
    }) => {
      const items = page.locator(".incident-item");
      await items.nth(index).click();
      await expect(
        page.locator("button.btn-evidence", { hasText: /Open Evidence Studio/i }),
      ).toBeVisible();
    });
  }

  test("selected incident is highlighted in LeftRail", async ({ page }) => {
    const items = page.locator(".incident-item");
    await items.nth(2).click();
    // Active item gets the "active" class
    await expect(items.nth(2)).toHaveClass(/active/);
  });
});
