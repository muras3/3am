/**
 * Record a smooth video demo of the 3am Console UI using Playwright video recording.
 * Converts to GIF via ffmpeg.
 *
 * Usage: npx tsx scripts/record-demo.ts
 * Prerequisites: Receiver running on localhost:3333 with a diagnosed incident.
 */
import { chromium } from "playwright";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = join(__dirname, "../assets");
const VIDEO_DIR = join(ASSETS_DIR, "video-tmp");
const OUTPUT_GIF = join(ASSETS_DIR, "demo.gif");
const BASE_URL = "http://localhost:3333";
const VIEWPORT = { width: 1280, height: 720 };

async function main() {
  rmSync(VIDEO_DIR, { recursive: true, force: true });
  mkdirSync(VIDEO_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: "dark",
    recordVideo: {
      dir: VIDEO_DIR,
      size: { width: VIEWPORT.width * 2, height: VIEWPORT.height * 2 },
    },
  });
  const page = await context.newPage();

  // --- Scene 1: Landing page (map view) ---
  console.log("Scene 1: Landing page...");
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);

  // --- Scene 2: Navigate to incident ---
  console.log("Scene 2: Incident board...");
  await page.goto(`${BASE_URL}/incidents/inc_000002`, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);

  // --- Scene 3: Slowly scroll down to reveal diagnosis content ---
  console.log("Scene 3: Scrolling through diagnosis...");
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollBy({ top: 150, behavior: "smooth" }));
    await page.waitForTimeout(800);
  }

  // --- Scene 4: Scroll back up ---
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await page.waitForTimeout(1500);

  // --- Scene 5: Evidence tab ---
  console.log("Scene 4: Evidence tab...");
  const evidenceNav = page.locator('text=Evidence').first();
  if (await evidenceNav.isVisible().catch(() => false)) {
    await evidenceNav.click({ force: true }).catch(() => {});
    await page.waitForTimeout(2500);
  }

  // --- Scene 6: Back to Incident ---
  const incidentNav = page.locator('text=Incident').first();
  if (await incidentNav.isVisible().catch(() => false)) {
    await incidentNav.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1500);
  }

  // --- Scene 7: AI Copilot chat ---
  console.log("Scene 5: AI Copilot...");
  // Look for copilot input or chat area
  const copilotInput = page.locator(
    'input[placeholder*="Ask"], textarea[placeholder*="Ask"], ' +
    'input[placeholder*="質問"], textarea[placeholder*="質問"], ' +
    '[data-testid="copilot-input"], .copilot-input input, .copilot-input textarea'
  ).first();

  if (await copilotInput.isVisible().catch(() => false)) {
    try {
      // Scroll copilot input into view and focus via JS to avoid intercept issues
      await copilotInput.evaluate((el: HTMLInputElement) => {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      await page.waitForTimeout(1000);
      await copilotInput.focus();
      await page.waitForTimeout(500);

      // Type a question character by character for animation effect
      const question = "What caused the 504 timeout?";
      await page.keyboard.type(question, { delay: 60 });
      await page.waitForTimeout(800);

      // Submit
      await page.keyboard.press("Enter");
      await page.waitForTimeout(10000); // Wait for AI response
    } catch (e) {
      console.log("  Copilot interaction failed, continuing...", String(e).slice(0, 80));
    }
  }

  // --- Scene 8: Hold on final state ---
  await page.waitForTimeout(2000);

  // Close context to finalize video
  await context.close();
  await browser.close();

  // Find the recorded video file
  const videoFiles = execSync(`ls "${VIDEO_DIR}"/*.webm 2>/dev/null || true`).toString().trim().split("\n").filter(Boolean);
  if (videoFiles.length === 0) {
    console.error("No video recorded!");
    process.exit(1);
  }
  const videoPath = videoFiles[0]!;
  console.log(`\nVideo recorded: ${videoPath}`);

  // Convert to GIF with good quality
  console.log("Converting to GIF...");

  // Step 1: Generate palette
  execSync(
    `ffmpeg -y -i "${videoPath}" ` +
    `-vf "fps=12,scale=800:-1:flags=lanczos,palettegen=max_colors=256:stats_mode=diff" ` +
    `"${VIDEO_DIR}/palette.png"`,
    { stdio: "inherit" },
  );

  // Step 2: Create GIF with palette
  execSync(
    `ffmpeg -y -i "${videoPath}" -i "${VIDEO_DIR}/palette.png" ` +
    `-lavfi "fps=12,scale=800:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=sierra2_4a" ` +
    `"${OUTPUT_GIF}"`,
    { stdio: "inherit" },
  );

  const sizeKB = Math.round(Number(execSync(`stat -f%z "${OUTPUT_GIF}"`).toString().trim()) / 1024);
  console.log(`\nGIF saved: ${OUTPUT_GIF} (${sizeKB} KB)`);

  // If too large (>5MB), reduce quality
  if (sizeKB > 5000) {
    console.log("GIF too large, reducing fps...");
    execSync(
      `ffmpeg -y -i "${videoPath}" ` +
      `-vf "fps=8,scale=640:-1:flags=lanczos,palettegen=max_colors=128" ` +
      `"${VIDEO_DIR}/palette2.png"`,
      { stdio: "inherit" },
    );
    execSync(
      `ffmpeg -y -i "${videoPath}" -i "${VIDEO_DIR}/palette2.png" ` +
      `-lavfi "fps=8,scale=640:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5" ` +
      `"${OUTPUT_GIF}"`,
      { stdio: "inherit" },
    );
    const newSizeKB = Math.round(Number(execSync(`stat -f%z "${OUTPUT_GIF}"`).toString().trim()) / 1024);
    console.log(`Reduced GIF: ${newSizeKB} KB`);
  }

  // Cleanup
  rmSync(VIDEO_DIR, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
