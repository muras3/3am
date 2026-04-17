import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { E2E_RECEIVER_SERVED_CLAIM_URL } from "../../playwright.receiver-served.config.js";

test.describe("Claim bootstrap", () => {
  test("a fresh browser session can enter through the one-time sign-in link", async ({ browser }) => {
    const claimUrl = readFileSync(E2E_RECEIVER_SERVED_CLAIM_URL, "utf8").trim();
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();

    await page.goto(claimUrl);
    await expect(page.locator("body")).toBeVisible();
    await expect(page.getByText("Open Your Sign-In Link")).toHaveCount(0);

    const cookies = await context.cookies();
    expect(cookies.some((cookie) => cookie.name === "console_session")).toBe(true);

    const diagnosisStatus = await page.evaluate(async () => {
      const res = await fetch("/api/settings/diagnosis");
      return res.status;
    });
    expect(diagnosisStatus).toBe(200);

    await context.close();
  });
});
