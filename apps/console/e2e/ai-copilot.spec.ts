import { test, expect } from "@playwright/test";

/**
 * AI Copilot chat E2E tests.
 *
 * The mock Anthropic server (started in global-setup) returns a fixed reply:
 *   "Disable the Stripe retry loop immediately to stop the cascade."
 *
 * All tests use the first seeded incident (which has a diagnosisResult attached).
 */
test.describe("AI Copilot", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForURL(/[?&]incidentId=/);
    // Wait for diagnosis data to load so the RightRail shows the chat input
    await expect(page.locator(".right-rail .chat-input-field")).toBeEnabled();
  });

  test("chat input is present and enabled when diagnosis is loaded", async ({ page }) => {
    await expect(page.locator(".right-rail .chat-input-field")).toBeVisible();
    await expect(page.locator(".right-rail .send-btn")).toBeVisible();
  });

  test("typing a message and pressing Send shows the reply", async ({ page }) => {
    await page.fill(".chat-input-field", "What should I do first?");
    await page.click(".send-btn");
    // Reply from mock Anthropic server should appear
    await expect(
      page.locator(".chat-bubble-assistant", {
        hasText: /Disable the Stripe retry loop/i,
      }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("pressing Enter sends the message", async ({ page }) => {
    await page.fill(".chat-input-field", "Is this deploy-related?");
    await page.press(".chat-input-field", "Enter");
    await expect(
      page.locator(".chat-bubble-assistant", {
        hasText: /Disable the Stripe retry loop/i,
      }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("user message appears as a bubble before the reply", async ({ page }) => {
    const userMsg = "What tells us the action worked?";
    await page.fill(".chat-input-field", userMsg);
    await page.click(".send-btn");
    await expect(page.locator(".chat-bubble-user", { hasText: userMsg })).toBeVisible();
    await expect(page.locator(".chat-bubble-assistant")).toBeVisible({ timeout: 10_000 });
  });

  test("quick prompt chip click sends a message", async ({ page }) => {
    const chip = page.locator(".ask-chip").first();
    const chipText = await chip.textContent();
    await chip.click();
    // The chip text should appear as a user bubble
    await expect(
      page.locator(".chat-bubble-user", { hasText: chipText ?? "" }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".chat-bubble-assistant")).toBeVisible({ timeout: 10_000 });
  });
});
