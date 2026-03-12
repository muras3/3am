import { test, expect } from "@playwright/test";

/**
 * Phase 1 product definition gate tests.
 *
 * Verifies that the IncidentBoard and RightRail refactor matches the
 * product definition spec: section DOM order, CSS border tokens, and
 * Evidence Studio proof-first layout.
 *
 * All tests run against the Vite dev server (pnpm e2e).
 */
test.describe("Phase 1 product definition gate", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForURL(/\/incidents\//);
    // Wait for the board to render with diagnosis data
    await expect(page.locator("[data-section='what-broke']")).toBeVisible();
  });

  test("section order matches product definition", async ({ page }) => {
    const attrs = await page.locator("[data-section]").evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-section")),
    );
    expect(attrs).toEqual([
      "what-broke",
      "action",
      "recovery",
      "cause",
      "evidence",
    ]);
  });

  test("RecoveryCard has green top border", async ({ page }) => {
    await expect(page.locator(".section-recovery")).toHaveCSS(
      "border-top-color",
      "rgb(46, 125, 82)",
    );
  });

  test("CauseCard has teal left border", async ({ page }) => {
    await expect(page.locator(".section-cause")).toHaveCSS(
      "border-left-color",
      "rgb(13, 115, 119)",
    );
  });

  test("Evidence Studio shows proof cards before tabs", async ({ page }) => {
    await page.click("[data-testid='open-evidence-studio']");
    await expect(page.locator(".evidence-modal")).toBeVisible();
    // proof-cards must be visible in the initial viewport (above the tab bar)
    // without any scrolling required
    await expect(page.locator("[data-testid='proof-cards']")).toBeVisible();
  });

  test("right rail order: uncertainty first, chat last", async ({ page }) => {
    const attrs = await page
      .locator("[data-rail-section]")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-rail-section")));
    expect(attrs[0]).toBe("uncertainty");
    expect(attrs[attrs.length - 1]).toBe("chat");
    // Full expected order: uncertainty → confidence → operator-check → chat
    expect(attrs).toEqual([
      "uncertainty",
      "confidence",
      "operator-check",
      "chat",
    ]);
  });
});
