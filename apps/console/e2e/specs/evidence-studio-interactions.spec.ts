import { test, expect } from "@playwright/test";
import { gotoFirstIncident } from "../helpers.js";

const MOCK_ANTHROPIC_REPLY = "Disable the Stripe retry loop immediately to stop the cascade.";

/**
 * Navigate to L2 Evidence Studio for the first seeded incident.
 * Uses URL params directly for deterministic navigation — avoids relying on
 * UI click chains that may vary between CI and local.
 */
async function gotoEvidenceStudio(
  page: Parameters<typeof gotoFirstIncident>[0],
): Promise<string> {
  const incidentId = await gotoFirstIncident(page);
  // Navigate directly to level=2 so LensShell renders LensEvidenceStudio
  await page.goto(`/?incidentId=${incidentId}&level=2&tab=traces`);
  // Wait for either the studio content OR error state to appear
  await page.waitForFunction(
    "document.querySelector('.lens-ev-studio') || document.querySelector('.lens-ev-error')",
    { timeout: 15_000 },
  );
  // If the error state appeared, the evidence API failed — surface the error
  const error = page.locator(".lens-ev-error");
  if (await error.count() > 0) {
    const errorText = await error.textContent();
    throw new Error(`Evidence Studio loaded with error: ${errorText}`);
  }
  return incidentId;
}

test.describe("L2 Evidence Studio — interactions", () => {
  test("proof cards are visible", async ({ page }) => {
    await gotoEvidenceStudio(page);

    // At least one proof card must be rendered
    const cards = page.locator(".lens-ev-proof-card");
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });

    // Seeded incidents include trigger / design_gap / recovery cards (3 total)
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test("clicking proof card switches tab", async ({ page }) => {
    await gotoEvidenceStudio(page);

    // Wait for proof cards to be rendered
    await page.locator(".lens-ev-proof-card").first().waitFor({ state: "visible", timeout: 10_000 });

    // Click the trigger card — its targetSurface is "traces"
    const triggerCard = page.locator('[data-proof-id="trigger"]');
    await triggerCard.waitFor({ state: "visible", timeout: 5_000 });
    await triggerCard.click();

    // The traces tab should become aria-selected
    const tracesTab = page.locator('[role="tab"][id="ev-tab-traces"]');
    await expect(tracesTab).toHaveAttribute("aria-selected", "true");

    // Click the design_gap card — its targetSurface is "metrics"
    const designGapCard = page.locator('[data-proof-id="design_gap"]');
    await designGapCard.waitFor({ state: "visible", timeout: 5_000 });
    await designGapCard.click();

    const metricsTab = page.locator('[role="tab"][id="ev-tab-metrics"]');
    await expect(metricsTab).toHaveAttribute("aria-selected", "true");
  });

  test("span rows are visible in traces", async ({ page }) => {
    await gotoEvidenceStudio(page);

    // Ensure we're on the traces tab
    await page.goto(
      `/?incidentId=${await gotoFirstIncident(page)}&level=2&tab=traces`,
    );

    await page.waitForFunction(
      "!document.querySelector('.lens-ev-loading')",
      { timeout: 10_000 },
    );

    // Wait for at least one span row to appear
    const spanRows = page.locator(".lens-traces-span-row");
    await spanRows.first().waitFor({ state: "visible", timeout: 10_000 });

    const count = await spanRows.count();
    expect(count).toBeGreaterThan(0);
  });

  test("clicking expandable span shows detail", async ({ page }) => {
    await gotoEvidenceStudio(page);

    // Find the first expandable span row
    const expandableRow = page.locator(".lens-traces-span-row.expandable").first();
    await expandableRow.waitFor({ state: "visible", timeout: 10_000 });

    // Click to expand it
    await expandableRow.click();

    // The sibling detail element should gain the .open class
    // Detail element immediately follows the span row in the DOM
    const detailOpen = page.locator(".lens-traces-span-detail.open").first();
    await expect(detailOpen).toBeVisible({ timeout: 5_000 });

    // Attributes should be rendered as a dl element inside the detail panel
    const attrList = detailOpen.locator("dl.lens-traces-attr-list");
    await expect(attrList).toBeVisible();
  });

  test("baseline toggle shows expected traces", async ({ page }) => {
    await gotoEvidenceStudio(page);

    // Baseline group starts as .muted
    const baselineGroup = page.locator(".lens-traces-baseline-group");
    await baselineGroup.waitFor({ state: "attached", timeout: 10_000 });
    await expect(baselineGroup).toHaveClass(/muted/);

    // Click the baseline toggle button
    const toggleButton = page.locator(".lens-traces-baseline-toggle:not(.disabled)");
    await toggleButton.waitFor({ state: "visible", timeout: 5_000 });
    await toggleButton.click();

    // After toggle the .muted class should be removed
    await expect(baselineGroup).not.toHaveClass(/muted/);
  });

  test("tab switching preserves URL state", async ({ page }) => {
    await gotoEvidenceStudio(page);

    // Switch to Metrics tab
    const metricsTab = page.locator('[role="tab"][id="ev-tab-metrics"]');
    await metricsTab.waitFor({ state: "visible", timeout: 10_000 });
    await metricsTab.click();
    await expect(page).toHaveURL(/[?&]tab=metrics/);

    // Switch to Logs tab
    const logsTab = page.locator('[role="tab"][id="ev-tab-logs"]');
    await logsTab.click();
    await expect(page).toHaveURL(/[?&]tab=logs/);

    // Switch back to Traces tab
    const tracesTab = page.locator('[role="tab"][id="ev-tab-traces"]');
    await tracesTab.click();
    await expect(page).toHaveURL(/[?&]tab=traces/);
  });

  test("Q&A input accepts text and submits", async ({ page }) => {
    await gotoEvidenceStudio(page);

    // Wait for Q&A frame to be rendered
    const qaInput = page.locator(".lens-ev-qa-input");
    await qaInput.waitFor({ state: "visible", timeout: 10_000 });

    // Clear and type a question
    await qaInput.fill("");
    await qaInput.fill("What caused the rate limit cascade?");

    // Submit button should be enabled now
    const submitButton = page.locator(".lens-ev-qa-submit");
    await expect(submitButton).toBeEnabled();
    await submitButton.click();

    // The mock Anthropic server returns a deterministic reply — wait for it
    const answerEl = page.locator(".lens-ev-qa-answer-live");
    await answerEl.waitFor({ state: "visible", timeout: 15_000 });
    await expect(answerEl).toContainText(MOCK_ANTHROPIC_REPLY);
  });

  test("follow-up chip triggers submission", async ({ page }) => {
    await gotoEvidenceStudio(page);

    // Wait for the Q&A frame to render with followup chips
    const chip = page.locator(".lens-ev-qa-chip").first();
    await chip.waitFor({ state: "visible", timeout: 10_000 });

    // The chip text is the question it will submit
    const chipText = (await chip.textContent()) ?? "";

    // Click the chip
    await chip.click();

    // The chip's question should appear as the latest live reply or
    // the submit button should cycle through submitting state.
    // The mock server returns a fixed reply, so just check it appears.
    const answerEl = page.locator(".lens-ev-qa-answer-live");
    await answerEl.waitFor({ state: "visible", timeout: 15_000 });
    // The answer is the mock reply regardless of question
    await expect(answerEl).toContainText(MOCK_ANTHROPIC_REPLY);

    // Confirm the chip text is non-empty (sanity check that chips are seeded)
    expect(chipText.trim().length).toBeGreaterThan(0);
  });

  test("side rail shows contextual notes", async ({ page }) => {
    await gotoEvidenceStudio(page);

    // Side notes should be rendered
    const notes = page.locator(".lens-ev-side-note");
    await notes.first().waitFor({ state: "visible", timeout: 10_000 });

    const count = await notes.count();
    expect(count).toBeGreaterThan(0);

    // The confidence note has the primary modifier class
    const primaryNote = page.locator(".lens-ev-side-note.lens-ev-side-note-primary");
    await expect(primaryNote).toBeVisible({ timeout: 5_000 });
  });
});
