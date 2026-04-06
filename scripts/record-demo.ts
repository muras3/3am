/**
 * Record a high-quality animated GIF demo of the 3am Console UI.
 *
 * Uses sequential PNG screenshots (not Playwright video recording) to avoid
 * VP8 color compression artifacts. This gives us accurate colors — critical
 * for the dark canvas effect on GitHub dark mode.
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
const FRAMES_DIR = join(ASSETS_DIR, "frames-tmp");
const OUTPUT_GIF = join(ASSETS_DIR, "demo.gif");
const BASE_URL = "http://localhost:3333";

// 920px stays above 900px breakpoint (2-column layout).
// 400px keeps content dense.
const VIEWPORT = { width: 920, height: 400 };
const FPS = 12;
const FRAME_INTERVAL = Math.round(1000 / FPS);

let frameCount = 0;

async function captureFrame(page: Page) {
  const path = join(FRAMES_DIR, `frame_${String(frameCount).padStart(5, "0")}.png`);
  await page.screenshot({ path });
  frameCount++;
}

async function captureForDuration(page: Page, durationMs: number) {
  const frames = Math.round(durationMs / FRAME_INTERVAL);
  for (let i = 0; i < frames; i++) {
    await captureFrame(page);
    if (i < frames - 1) await page.waitForTimeout(FRAME_INTERVAL);
  }
}

/** Capture smooth scroll as a series of frames. */
async function captureScroll(page: Page, distance: number, steps: number) {
  const step = Math.round(distance / steps);
  for (let i = 0; i < steps; i++) {
    await page.evaluate((s) => window.scrollBy({ top: s, behavior: "instant" }), step);
    await page.waitForTimeout(50);
    await captureFrame(page);
    await page.waitForTimeout(FRAME_INTERVAL - 50);
  }
}

/** Apply dark canvas + recording overrides. */
async function applyRecordingOverrides(page: Page) {
  await page.evaluate(() => {
    const bg = "#111";
    // Dark canvas on all structural elements
    [document.documentElement, document.body].forEach((el) => {
      el.style.setProperty("background", bg, "important");
    });
    document.querySelectorAll("#root, .lens-world, .level").forEach((el) => {
      (el as HTMLElement).style.setProperty("background", bg, "important");
    });
    // White card for content areas
    document.querySelectorAll(".lens-board-content, .lens-ev-studio-body").forEach((el) => {
      const h = el as HTMLElement;
      h.style.setProperty("background", "#fff", "important");
      h.style.setProperty("border-radius", "8px", "important");
      h.style.setProperty("padding", "20px", "important");
    });
    // Keep header white
    document.querySelectorAll(".level-header").forEach((el) => {
      (el as HTMLElement).style.setProperty("background", "#fff", "important");
    });
    // Hide breadcrumb
    document.querySelectorAll(".zoom-nav").forEach((el) => {
      (el as HTMLElement).style.setProperty("display", "none", "important");
    });
  });
  await page.waitForTimeout(100);
}

async function main() {
  rmSync(FRAMES_DIR, { recursive: true, force: true });
  mkdirSync(FRAMES_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  // --- Scene 1: Map view (2s) ---
  console.log("Scene 1: Map view...");
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await applyRecordingOverrides(page);
  await captureForDuration(page, 2000);

  // --- Scene 2: Click into incident → Board ---
  console.log("Scene 2: Click incident → Board...");
  const incidentRow = page.locator(".incident-strip-row, .lens-map-incident-row, [data-incident-id]").first();
  if (await incidentRow.isVisible().catch(() => false)) {
    await incidentRow.click({ force: true });
    await page.waitForTimeout(800);
  } else {
    await page.goto(`${BASE_URL}/incidents/inc_000002`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
  }
  await applyRecordingOverrides(page);
  await captureForDuration(page, 2500);

  // --- Scene 3: Scroll down to reveal more diagnosis content (3s) ---
  console.log("Scene 3: Scroll through diagnosis...");
  await captureScroll(page, 500, 8);
  await captureForDuration(page, 1000);

  // --- Scene 4: Scroll back up (1s) ---
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.waitForTimeout(100);
  await captureForDuration(page, 800);

  // --- Scene 5: Click "Open Evidence Studio now" → Evidence Studio ---
  console.log("Scene 4: Evidence Studio...");
  await page.evaluate(() =>
    document.querySelector(".lens-board-btn-evidence")?.scrollIntoView({ behavior: "instant", block: "center" }),
  );
  await page.waitForTimeout(300);
  const evidenceBtn = page.locator("button:has-text('Open Evidence Studio')").first();
  if (await evidenceBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await evidenceBtn.click();
    await page.waitForTimeout(1200);
    await applyRecordingOverrides(page);
    await captureForDuration(page, 1500);
  }

  // --- Scene 6: Copilot Q&A (real LLM) ---
  console.log("Scene 5: Copilot Q&A (live LLM)...");
  const qaInput = page.locator(".lens-ev-qa-input").first();
  if (await qaInput.isVisible().catch(() => false)) {
    await qaInput.focus();
    await captureForDuration(page, 300);

    // Type question frame by frame
    const question = "What caused the 504 timeout?";
    for (const char of question) {
      await page.keyboard.type(char);
      await captureFrame(page);
      await page.waitForTimeout(40);
    }
    await captureForDuration(page, 400);

    // Submit and wait for LLM response
    await page.keyboard.press("Enter");
    console.log("  Waiting for LLM response...");

    // Capture frames while waiting for response
    const startTime = Date.now();
    const maxWait = 20000;
    let responseReceived = false;
    while (Date.now() - startTime < maxWait) {
      await captureFrame(page);
      await page.waitForTimeout(FRAME_INTERVAL);
      // Check if response appeared
      if (!responseReceived) {
        const hasResponse = await page.evaluate(() => {
          const bubbles = document.querySelectorAll(".lens-ev-qa-bubble-assistant");
          for (const b of bubbles) {
            if (!b.classList.contains("lens-ev-qa-answer-placeholder") && b.textContent && b.textContent.length > 30) {
              return true;
            }
          }
          return false;
        });
        if (hasResponse) {
          responseReceived = true;
          console.log("  LLM response received!");
          // Capture a few more seconds of the response
          await captureForDuration(page, 2500);
          break;
        }
      }
    }
  } else {
    console.log("  QA input not found, holding...");
    await captureForDuration(page, 3000);
  }

  // --- Final hold ---
  await captureForDuration(page, 1000);

  await browser.close();

  console.log(`\nCaptured ${frameCount} frames at ${FPS}fps`);

  // --- Combine PNGs into GIF ---
  console.log("Generating GIF from PNG frames...");

  // Step 1: Generate palette from all frames
  execSync(
    `ffmpeg -y -framerate ${FPS} -i "${FRAMES_DIR}/frame_%05d.png" ` +
    `-vf "scale=924:-1:flags=lanczos,pad=928:iw*ih/924+4:2:2:color=#24292e,palettegen=max_colors=256:stats_mode=full" ` +
    `-update 1 "${FRAMES_DIR}/palette.png"`,
    { stdio: "inherit" },
  );

  // Step 2: Create GIF with palette
  execSync(
    `ffmpeg -y -framerate ${FPS} -i "${FRAMES_DIR}/frame_%05d.png" -i "${FRAMES_DIR}/palette.png" ` +
    `-lavfi "scale=924:-1:flags=lanczos,pad=928:iw*ih/924+4:2:2:color=#24292e [x]; [x][1:v] paletteuse=dither=sierra2_4a" ` +
    `-loop 0 "${OUTPUT_GIF}"`,
    { stdio: "inherit" },
  );

  const sizeKB = Math.round(
    Number(execSync(`stat -f%z "${OUTPUT_GIF}"`).toString().trim()) / 1024,
  );
  console.log(`\nGIF saved: ${OUTPUT_GIF} (${sizeKB} KB, ${frameCount} frames at ${FPS}fps)`);

  // Fallback: reduce quality if too large
  if (sizeKB > 5000) {
    console.log("GIF too large, reducing scale...");
    execSync(
      `ffmpeg -y -framerate ${FPS} -i "${FRAMES_DIR}/frame_%05d.png" ` +
      `-vf "scale=760:-1:flags=lanczos,pad=764:iw*ih/760+4:2:2:color=#24292e,palettegen=max_colors=192" ` +
      `-update 1 "${FRAMES_DIR}/palette2.png"`,
      { stdio: "inherit" },
    );
    execSync(
      `ffmpeg -y -framerate ${FPS} -i "${FRAMES_DIR}/frame_%05d.png" -i "${FRAMES_DIR}/palette2.png" ` +
      `-lavfi "scale=760:-1:flags=lanczos,pad=764:iw*ih/760+4:2:2:color=#24292e [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=4" ` +
      `-loop 0 "${OUTPUT_GIF}"`,
      { stdio: "inherit" },
    );
    const newSizeKB = Math.round(
      Number(execSync(`stat -f%z "${OUTPUT_GIF}"`).toString().trim()) / 1024,
    );
    console.log(`Reduced GIF: ${newSizeKB} KB`);
  }

  // Cleanup
  rmSync(FRAMES_DIR, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
