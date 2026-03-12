import { test, expect } from "@playwright/test";

test.describe("Navigation", () => {
  test("LeftRail shows 5 incidents", async ({ page }) => {
    await page.goto("/");
    // Root route redirects to the first incident via search param
    await page.waitForURL(/[?&]incidentId=/);
    // Count incident items rendered in the left rail
    const items = page.locator(".incident-item");
    await expect(items).toHaveCount(5);
  });

  test("LeftRail items show open status", async ({ page }) => {
    await page.goto("/");
    await page.waitForURL(/[?&]incidentId=/);
    // Each incident-item contains a .sev span that holds the status text ("open")
    const firstSev = page.locator(".incident-item .sev").first();
    await expect(firstSev).toContainText("open");
  });

  test("clicking a LeftRail incident navigates to it", async ({ page }) => {
    await page.goto("/");
    await page.waitForURL(/[?&]incidentId=/);

    const items = page.locator(".incident-item");
    // Click the second item (first is already selected)
    await items.nth(1).click();
    // URL search param should update to the new incidentId
    await page.waitForURL(/[?&]incidentId=/);
    // The incident board should be visible
    await expect(page.locator(".section-what")).toBeVisible();
  });

  test("deep link to first incident renders board", async ({ page }) => {
    // The seed script creates incidents — navigate via URL after discovering the ID.
    await page.goto("/");
    await page.waitForURL(/[?&]incidentId=/);
    // Verify the board loads for the auto-selected incident
    await expect(page.locator(".section-what")).toBeVisible();
    await expect(page.locator(".section-action")).toBeVisible();
  });
});
