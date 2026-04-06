/**
 * Record a high-quality animated GIF demo of the 3am Console UI.
 *
 * Flow: Map → Incident Board → scroll → Evidence Studio → Copilot Q&A (real LLM)
 *
 * Usage: npx tsx scripts/record-demo.ts
 * Prerequisites:
 *   - Receiver running on localhost:3333 with a diagnosed incident (inc_000002)
 *   - ANTHROPIC_API_KEY set in env (for live Copilot response)
 */
import { chromium, type Page } from "playwright";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = join(__dirname, "../assets");
const VIDEO_DIR = join(ASSETS_DIR, "video-tmp");
const OUTPUT_GIF = join(ASSETS_DIR, "demo.gif");
const BASE_URL = "http://localhost:3333";

// 960px fits board max-width (860px) + padding with minimal dead space.
// 640px height keeps aspect ratio tight.
const VIEWPORT = { width: 960, height: 640 };

async function smoothScroll(page: Page, distance: number, steps: number, interval: number) {
  const step = Math.round(distance / steps);
  for (let i = 0; i < steps; i++) {
    await page.evaluate((s) => window.scrollBy({ top: s, behavior: "smooth" }), step);
    await page.waitForTimeout(interval);
  }
}

async function main() {
  rmSync(VIDEO_DIR, { recursive: true, force: true });
  mkdirSync(VIDEO_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    recordVideo: {
      dir: VIDEO_DIR,
      size: { width: VIEWPORT.width * 2, height: VIEWPORT.height * 2 },
    },
  });
  const page = await context.newPage();

  // --- Scene 1: Map view (2.5s) ---
  console.log("Scene 1: Map view...");
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);

  // --- Scene 2: Click into incident → Board (zoom transition) ---
  console.log("Scene 2: Click incident → Board...");
  const incidentRow = page.locator(".incident-strip-row, .lens-map-incident-row, [data-incident-id]").first();
  if (await incidentRow.isVisible().catch(() => false)) {
    await incidentRow.click({ force: true });
    await page.waitForTimeout(2000);
  } else {
    // Fallback: direct navigation
    await page.goto(`${BASE_URL}/incidents/inc_000002`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
  }

  // --- Scene 3: Board — hold to show diagnosis headline (2s) ---
  console.log("Scene 3: Diagnosis headline...");
  await page.waitForTimeout(2000);

  // --- Scene 4: Scroll down to reveal operator steps & causal chain (3s) ---
  console.log("Scene 4: Scroll through diagnosis...");
  await smoothScroll(page, 500, 5, 500);
  await page.waitForTimeout(500);

  // --- Scene 5: Scroll back up (1s) ---
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await page.waitForTimeout(1000);

  // --- Scene 6: Click "Open Evidence Studio now" → zoom to Level 2 ---
  console.log("Scene 5: Evidence Studio...");
  // Scroll down to make the button visible first
  await page.evaluate(() => document.querySelector(".lens-board-btn-evidence")?.scrollIntoView({ behavior: "smooth", block: "center" }));
  await page.waitForTimeout(800);
  const evidenceBtn = page.locator("button:has-text('Open Evidence Studio')").first();
  if (await evidenceBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await evidenceBtn.click();
    // Wait for zoom transition to Evidence Studio
    await page.waitForTimeout(2500);
  } else {
    console.log("  Evidence Studio button not found, trying breadcrumb...");
    const breadcrumb = page.locator("text=Evidence").first();
    if (await breadcrumb.isVisible().catch(() => false)) {
      await breadcrumb.click();
      await page.waitForTimeout(2500);
    }
  }

  // --- Scene 7: Copilot Q&A — type question, get real LLM response ---
  console.log("Scene 6: Copilot Q&A (live LLM)...");
  const qaInput = page.locator(".lens-ev-qa-input").first();

  if (await qaInput.isVisible().catch(() => false)) {
    await qaInput.focus();
    await page.waitForTimeout(400);

    // Type question character by character
    const question = "What caused the 504 timeout?";
    await page.keyboard.type(question, { delay: 50 });
    await page.waitForTimeout(600);

    // Submit and wait for real LLM response
    await page.keyboard.press("Enter");
    console.log("  Waiting for LLM response...");

    // Wait for the response bubble to appear (max 20s)
    try {
      await page.waitForSelector(
        ".lens-ev-qa-bubble-assistant:not(.lens-ev-qa-answer-placeholder)",
        { timeout: 20000 },
      );
      // Extra time to let the full response render
      await page.waitForTimeout(2000);
    } catch {
      console.log("  LLM response timeout, continuing...");
      await page.waitForTimeout(2000);
    }
  } else {
    console.log("  QA input not found, holding on evidence view...");
    await page.waitForTimeout(3000);
  }

  // --- Scene 8: Hold on final state (1.5s) ---
  await page.waitForTimeout(1500);

  // Finalize video
  await context.close();
  await browser.close();

  // Find recorded video
  const videoFiles = execSync(`ls "${VIDEO_DIR}"/*.webm 2>/dev/null || true`)
    .toString().trim().split("\n").filter(Boolean);
  if (videoFiles.length === 0) {
    console.error("No video recorded!");
    process.exit(1);
  }
  const videoPath = videoFiles[0]!;
  console.log(`\nVideo recorded: ${videoPath}`);

  // --- GIF encoding (high quality, proper loop) ---
  console.log("Converting to GIF...");

  // Step 1: Generate full-frame palette (better color accuracy than diff mode)
  execSync(
    `ffmpeg -y -i "${videoPath}" ` +
    `-vf "fps=15,scale=960:-1:flags=lanczos,palettegen=max_colors=256:stats_mode=full" ` +
    `-update 1 "${VIDEO_DIR}/palette.png"`,
    { stdio: "inherit" },
  );

  // Step 2: Create GIF with palette, explicit infinite loop
  execSync(
    `ffmpeg -y -i "${videoPath}" -i "${VIDEO_DIR}/palette.png" ` +
    `-lavfi "fps=15,scale=960:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=sierra2_4a" ` +
    `-loop 0 "${OUTPUT_GIF}"`,
    { stdio: "inherit" },
  );

  const sizeKB = Math.round(
    Number(execSync(`stat -f%z "${OUTPUT_GIF}"`).toString().trim()) / 1024,
  );
  console.log(`\nGIF saved: ${OUTPUT_GIF} (${sizeKB} KB)`);

  // If too large (>5MB), reduce quality
  if (sizeKB > 5000) {
    console.log("GIF too large, reducing fps and scale...");
    execSync(
      `ffmpeg -y -i "${videoPath}" ` +
      `-vf "fps=10,scale=800:-1:flags=lanczos,palettegen=max_colors=192" ` +
      `-update 1 "${VIDEO_DIR}/palette2.png"`,
      { stdio: "inherit" },
    );
    execSync(
      `ffmpeg -y -i "${videoPath}" -i "${VIDEO_DIR}/palette2.png" ` +
      `-lavfi "fps=10,scale=800:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=4" ` +
      `-loop 0 "${OUTPUT_GIF}"`,
      { stdio: "inherit" },
    );
    const newSizeKB = Math.round(
      Number(execSync(`stat -f%z "${OUTPUT_GIF}"`).toString().trim()) / 1024,
    );
    console.log(`Reduced GIF: ${newSizeKB} KB`);
  }

  // Cleanup
  rmSync(VIDEO_DIR, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
