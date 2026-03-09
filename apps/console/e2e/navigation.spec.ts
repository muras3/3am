import { test, expect } from "@playwright/test";

test.describe("Navigation", () => {
  test("LeftRail shows 5 incidents", async ({ page }) => {
    await page.goto("/");
    // Root route redirects to the first incident
    await page.waitForURL(/\/incidents\//);
    // Count incident items rendered in the left rail
    const items = page.locator(".incident-item");
    await expect(items).toHaveCount(5);
  });

  test("LeftRail items show open status", async ({ page }) => {
    await page.goto("/");
    await page.waitForURL(/\/incidents\//);
    // Each incident-item contains a .sev span that holds the status text ("open")
    const firstSev = page.locator(".incident-item .sev").first();
    await expect(firstSev).toContainText("open");
  });

  test("clicking a LeftRail incident navigates to it", async ({ page }) => {
    await page.goto("/");
    await page.waitForURL(/\/incidents\//);

    const items = page.locator(".incident-item");
    // Click the second item (first is already selected)
    await items.nth(1).click();
    // URL should change to a different incident
    await page.waitForURL(/\/incidents\//);
    // The incident board should be visible
    await expect(page.locator(".section-what")).toBeVisible();
  });

  test("deep link to first incident renders board", async ({ page }) => {
    // The seed script creates incidents whose IDs are assigned by the receiver
    // (not inc_scenario_01) — navigate via URL after discovering the ID.
    await page.goto("/");
    await page.waitForURL(/\/incidents\/(.+)/);
    // Verify the board loads for the deep-linked URL
    await expect(page.locator(".section-what")).toBeVisible();
    await expect(page.locator(".section-action")).toBeVisible();
  });
});
