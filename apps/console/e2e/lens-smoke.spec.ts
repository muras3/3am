import { test, expect } from "@playwright/test";

test.describe("Lens UI smoke", () => {
  test("app loads without errors", async ({ page }) => {
    await page.goto("/");
    // Verify the lens world container renders
    await expect(page.locator(".lens-world")).toBeVisible({ timeout: 10_000 });
  });
});
