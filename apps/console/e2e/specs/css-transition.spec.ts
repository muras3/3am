import { test, expect } from "@playwright/test";
import { gotoFirstIncident } from "../helpers.js";

/**
 * Phase 2 CSS transition gate tests.
 *
 * Verifies the in-place CSS transition shell:
 * - NormalSurface is shown at "/" (no incidentId) — with or without incidents in DB
 * - "/" does NOT auto-redirect to incident mode when incidents exist (P1 product fix)
 * - Incident workspace is shown at "/?incidentId=..."
 * - Both center divs are always in the DOM (never unmounted)
 * - Right rail expands when entering incident mode
 * - Legacy "/incidents/:id" URLs redirect to search-param form
 * - No transitions when prefers-reduced-motion: reduce is active
 */

test.describe("Phase 2 CSS transition shell", () => {
  test("/ shows NormalSurface when no incidentId in URL", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("[data-surface=normal]")).toBeVisible();
  });

  test("/ stays in normal mode even with seeded incidents — no auto-redirect", async ({
    page,
  }) => {
    // This test verifies the product behavior fix: seeded incidents must NOT
    // trigger an automatic redirect to incident mode. Normal mode is the ambient
    // base state; users enter incident mode by explicit navigation only.
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    expect(page.url()).not.toMatch(/[?&]incidentId=/);
    await expect(page.locator("[data-surface=normal]")).toBeVisible();
  });

  test("/?incidentId opens incident workspace", async ({ page }) => {
    await gotoFirstIncident(page);
    await expect(page.locator("[data-surface=incident]")).toBeVisible({ timeout: 6000 });
  });

  test("right rail expands to ~220px in incident mode", async ({ page }) => {
    await gotoFirstIncident(page);
    // Wait for the grid transition to complete (450ms + buffer)
    await page.waitForTimeout(600);
    const box = await page.locator(".right-rail").boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(215);
    expect(box!.width).toBeLessThanOrEqual(225);
  });

  test("center-normal and center-incident are always attached in normal mode", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page.locator(".center-normal")).toBeAttached();
    await expect(page.locator(".center-incident")).toBeAttached();
  });

  test("center-normal and center-incident are always attached in incident mode", async ({
    page,
  }) => {
    await gotoFirstIncident(page);
    await expect(page.locator(".center-normal")).toBeAttached();
    await expect(page.locator(".center-incident")).toBeAttached();
  });

  test("legacy /incidents/:id URL redirects to /?incidentId=", async ({ page }) => {
    await page.goto("/incidents/any-id-123");
    await page.waitForURL(/[?&]incidentId=/, { timeout: 5000 });
    expect(page.url()).toMatch(/[?&]incidentId=/);
  });

  test("no transition when prefers-reduced-motion: reduce", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const duration = await page.locator(".center-normal").evaluate(
      // evaluate runs in browser context; getComputedStyle is a browser global
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el) => (globalThis as any).getComputedStyle(el).transitionDuration as string,
    );
    // All transition-duration values should be "0s"
    expect(duration.split(",").every((d: string) => d.trim() === "0s")).toBe(true);
  });
});
