import { test, expect } from "@playwright/test";
import { gotoFirstIncident } from "./helpers.js";

test.describe("Navigation", () => {
  test("LeftRail shows 5 incidents in incident mode", async ({ page }) => {
    await gotoFirstIncident(page);
    // Count incident items rendered in the left rail (incident panel is now visible)
    const items = page.locator(".incident-item");
    await expect(items).toHaveCount(5);
  });

  test("LeftRail items show open status", async ({ page }) => {
    await gotoFirstIncident(page);
    // Each incident-item contains a .sev span that holds the status text ("open")
    const firstSev = page.locator(".incident-item .sev").first();
    await expect(firstSev).toContainText("open");
  });

  test("clicking a LeftRail incident navigates to it", async ({ page }) => {
    await gotoFirstIncident(page);

    const items = page.locator(".incident-item");
    // Click the second item
    await items.nth(1).click();
    // URL search param should update to the new incidentId
    await page.waitForURL(/[?&]incidentId=/);
    // The incident board should be visible
    await expect(page.locator(".section-what")).toBeVisible();
  });

  test("deep link to first incident renders board", async ({ page }) => {
    await gotoFirstIncident(page);
    // Verify the board loads for the directly-navigated incident
    await expect(page.locator(".section-what")).toBeVisible();
    await expect(page.locator(".section-action")).toBeVisible();
  });
});
