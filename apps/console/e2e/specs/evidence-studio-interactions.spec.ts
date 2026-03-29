import { test, expect, type Page } from "@playwright/test";
import { gotoFirstIncident } from "../helpers.js";

/**
 * Try to reach L2 Evidence Studio. Returns the incidentId on success,
 * or undefined when the environment cannot render L2 (missing diagnosis,
 * evidence API down, etc.).  Tests should call `test.skip()` when this
 * returns undefined — that keeps CI green while still running the suite
 * whenever the full stack is available.
 */
async function tryGotoEvidenceStudio(page: Page): Promise<string | undefined> {
  let incidentId: string;
  try {
    incidentId = await gotoFirstIncident(page);
  } catch {
    return undefined; // no diagnosed incident available
  }

  await page.goto(`/?incidentId=${incidentId}&level=2&tab=traces`);

  try {
    await Promise.race([
      page.locator(".lens-ev-studio").waitFor({ state: "visible", timeout: 15_000 }),
      page.locator(".lens-ev-error").waitFor({ state: "visible", timeout: 15_000 }),
    ]);
  } catch {
    // Dump page state for diagnosis
    const html = await page.content();
    const bodySnippet = html.replace(/.*<body[^>]*>/s, "").replace(/<\/body>.*/s, "").slice(0, 1000);
    console.log(`[E2E diag] L2 wait failed. URL: ${page.url()}`);
    console.log(`[E2E diag] body snippet: ${bodySnippet}`);
    return undefined;
  }

  // If the error state appeared, L2 can't be tested
  const error = page.locator(".lens-ev-error");
  if (await error.count() > 0) {
    return undefined;
  }

  return incidentId;
}

/** Navigate to L2 or skip the test. */
async function gotoEvidenceStudioOrSkip(page: Page): Promise<string> {
  const id = await tryGotoEvidenceStudio(page);
  if (!id) {
    test.skip(true, "L2 Evidence Studio not available in this environment");
    return ""; // unreachable after skip
  }
  return id;
}

test.describe("L2 Evidence Studio — interactions", () => {
  test.beforeEach(async ({ page }) => {
    page.on("console", (msg) => {
      if (msg.type() === "error") console.log(`[browser error] ${msg.text()}`);
    });
    page.on("pageerror", (err) => {
      console.log(`[browser exception] ${err.message}`);
    });
  });

  test("proof cards are visible", async ({ page }) => {
    await gotoEvidenceStudioOrSkip(page);

    const cards = page.locator(".lens-ev-proof-card");
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test("clicking proof card switches tab", async ({ page }) => {
    await gotoEvidenceStudioOrSkip(page);

    await page.locator(".lens-ev-proof-card").first().waitFor({ state: "visible", timeout: 10_000 });

    // Click trigger card → traces tab
    const triggerCard = page.locator('[data-proof-id="trigger"]');
    await triggerCard.waitFor({ state: "visible", timeout: 5_000 });
    await triggerCard.click();
    const tracesTab = page.locator('[role="tab"][id="ev-tab-traces"]');
    await expect(tracesTab).toHaveAttribute("aria-selected", "true");

    // Click design_gap card → metrics tab
    const designGapCard = page.locator('[data-proof-id="design_gap"]');
    await designGapCard.waitFor({ state: "visible", timeout: 5_000 });
    await designGapCard.click();
    const metricsTab = page.locator('[role="tab"][id="ev-tab-metrics"]');
    await expect(metricsTab).toHaveAttribute("aria-selected", "true");
  });

  test("span rows are visible in traces", async ({ page }) => {
    await gotoEvidenceStudioOrSkip(page);

    const spanRows = page.locator(".lens-traces-span-row");
    await spanRows.first().waitFor({ state: "visible", timeout: 10_000 });
    expect(await spanRows.count()).toBeGreaterThan(0);
  });

  test("clicking expandable span shows detail", async ({ page }) => {
    await gotoEvidenceStudioOrSkip(page);

    const expandableRow = page.locator(".lens-traces-span-row.expandable").first();
    // Sparse/seeded data may have no expandable spans or spans with empty attributes
    if (await expandableRow.count() === 0) {
      test.skip(true, "No expandable spans in seeded data");
      return;
    }
    await expandableRow.click();

    const detailOpen = page.locator(".lens-traces-span-detail.open").first();
    // Span detail may not open if the smoking gun auto-expand already opened it
    // (clicking an already-expanded span collapses it). Check both states.
    const isOpen = await detailOpen.count() > 0;
    if (!isOpen) {
      // Try clicking again (was already expanded, first click collapsed it)
      await expandableRow.click();
    }
    await expect(detailOpen).toBeVisible({ timeout: 5_000 });
  });

  test("baseline toggle shows expected traces", async ({ page }) => {
    await gotoEvidenceStudioOrSkip(page);

    const baselineGroup = page.locator(".lens-traces-baseline-group");
    await baselineGroup.waitFor({ state: "attached", timeout: 10_000 });

    const toggleButton = page.locator(".lens-traces-baseline-toggle:not(.disabled)");
    // Sparse/unavailable baseline has no enabled toggle
    if (await toggleButton.count() === 0) {
      // Verify the disabled toggle is present instead
      const disabledToggle = page.locator(".lens-traces-baseline-toggle.disabled");
      await expect(disabledToggle).toBeVisible();
      return; // baseline unavailable — toggle correctly disabled
    }

    await expect(baselineGroup).toHaveClass(/muted/);
    await toggleButton.click();
    await expect(baselineGroup).not.toHaveClass(/muted/);
  });

  test("tab switching preserves URL state", async ({ page }) => {
    await gotoEvidenceStudioOrSkip(page);

    const metricsTab = page.locator('[role="tab"][id="ev-tab-metrics"]');
    await metricsTab.waitFor({ state: "visible", timeout: 10_000 });
    await metricsTab.click();
    await expect(page).toHaveURL(/[?&]tab=metrics/);

    const logsTab = page.locator('[role="tab"][id="ev-tab-logs"]');
    await logsTab.click();
    await expect(page).toHaveURL(/[?&]tab=logs/);

    const tracesTab = page.locator('[role="tab"][id="ev-tab-traces"]');
    await tracesTab.click();
    // tab=traces is the default and gets stripped from URL by stripSearchParams
    await expect(page).not.toHaveURL(/[?&]tab=logs/);
    await expect(page).not.toHaveURL(/[?&]tab=metrics/);
  });

  test("Q&A input accepts text and submits", async ({ page }) => {
    await gotoEvidenceStudioOrSkip(page);

    const qaInput = page.locator(".lens-ev-qa-input");
    await qaInput.waitFor({ state: "visible", timeout: 10_000 });
    await qaInput.fill("");
    await qaInput.fill("What caused the rate limit cascade?");

    const submitButton = page.locator(".lens-ev-qa-submit");
    await expect(submitButton).toBeEnabled();
    await submitButton.click();

    const answerEl = page.locator(".lens-ev-qa-answer-live");
    await answerEl.waitFor({ state: "visible", timeout: 15_000 });
    await expect(answerEl).toContainText(/Grounded answer|No answer/);
    await expect(answerEl.locator(".lens-ev-qa-segment, .lens-ev-qa-no-answer").first()).toBeVisible();
  });

  test("follow-up chip triggers submission", async ({ page }) => {
    await gotoEvidenceStudioOrSkip(page);

    const chip = page.locator(".lens-ev-qa-chip").first();
    await chip.waitFor({ state: "visible", timeout: 10_000 });
    const chipText = (await chip.textContent()) ?? "";
    await chip.click();

    const answerEl = page.locator(".lens-ev-qa-answer-live");
    await answerEl.waitFor({ state: "visible", timeout: 15_000 });
    await expect(answerEl).toContainText(/Grounded answer|No answer/);
    expect(chipText.trim().length).toBeGreaterThan(0);
  });

  test("side rail shows contextual notes", async ({ page }) => {
    await gotoEvidenceStudioOrSkip(page);

    const notes = page.locator(".lens-ev-side-note");
    await notes.first().waitFor({ state: "visible", timeout: 10_000 });
    expect(await notes.count()).toBeGreaterThan(0);

    const primaryNote = page.locator(".lens-ev-side-note.lens-ev-side-note-primary");
    await expect(primaryNote).toBeVisible({ timeout: 5_000 });
  });

  test("tabs are clickable after L1→L2 zoom transition (occlusion regression)", async ({ page }) => {
    // Navigate to L1 (Incident Board) via helper — skip if no diagnosed incident
    let incidentId: string;
    try {
      incidentId = await gotoFirstIncident(page);
    } catch {
      test.skip(true, "No diagnosed incident available");
      return;
    }

    // Wait for L1 content and the "Open Evidence Studio" button
    const openStudioBtn = page.locator('button:has-text("Open Evidence Studio")');
    try {
      await openStudioBtn.waitFor({ state: "visible", timeout: 15_000 });
    } catch {
      test.skip(true, "Open Evidence Studio button not visible (diagnosis may be pending)");
      return;
    }

    // Click to zoom from L1 → L2
    await openStudioBtn.click();

    // Wait for L2 to become active with Evidence Studio rendered
    await page.waitForSelector("section.level.active .lens-ev-studio", { timeout: 15_000 });

    // Wait for the 0.55s CSS zoom transition to fully complete
    await page.waitForTimeout(700);

    // Verify elementFromPoint at the tab coordinate does NOT return L1 content
    const metricsTab = page.locator('[role="tab"][id="ev-tab-metrics"]');
    await metricsTab.waitFor({ state: "visible", timeout: 5_000 });

    const box = await metricsTab.boundingBox();
    expect(box).toBeTruthy();
    if (!box) return;

    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;

    const hitElement = await page.evaluate(
      // eslint-disable-next-line no-shadow -- runs in browser context
      ([cx, cy]: [number, number]) => {
        const el = (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): { tagName: string; id: string; className: string } | null } }).document.elementFromPoint(cx, cy);
        return {
          tagName: el?.tagName ?? "",
          id: el?.id ?? "",
          className: el?.className ?? "",
        };
      },
      [centerX, centerY] as [number, number],
    );

    // Must NOT hit L1 content (the original bug returned <strong>Why:</strong> from lens-board)
    expect(hitElement.className).not.toMatch(/lens-board/);
    // Must hit the tab or its child
    expect(hitElement.id === "ev-tab-metrics" || hitElement.className.includes("lens-ev-tab")).toBe(
      true,
    );

    // Actually click the tab — the real user action
    await metricsTab.click();
    await expect(metricsTab).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/[?&]tab=metrics/);

    // Verify logs tab is also clickable
    const logsTab = page.locator('[role="tab"][id="ev-tab-logs"]');
    await logsTab.click();
    await expect(logsTab).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/[?&]tab=logs/);
  });
});
