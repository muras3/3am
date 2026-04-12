import { test, expect } from "@playwright/test";

test.describe("Lens UI smoke (receiver-served)", () => {
  test("app loads without errors", async ({ page }) => {
    await page.goto("/");
    // Verify the app renders some content
    await expect(page.locator("body")).toBeVisible({ timeout: 10_000 });
  });
});
