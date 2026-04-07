/**
 * Record a high-quality animated GIF demo of the 3am Console UI.
 *
 * Uses sequential PNG screenshots (not video) for accurate color rendering.
 * No CSS overrides — captures the product exactly as users see it.
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
const VIEWPORT = { width: 920, height: 600 };
const FPS = 12;
const FRAME_MS = Math.round(1000 / FPS);

let frameCount = 0;

async function snap(page: Page) {
  await page.screenshot({
    path: join(FRAMES_DIR, `f${String(frameCount++).padStart(5, "0")}.png`),
  });
}

async function hold(page: Page, ms: number) {
  const n = Math.round(ms / FRAME_MS);
  for (let i = 0; i < n; i++) {
    await snap(page);
    if (i < n - 1) await page.waitForTimeout(FRAME_MS);
  }
}

async function scroll(page: Page, distance: number, durationMs: number) {
  const frames = Math.round(durationMs / FRAME_MS);
  const step = Math.round(distance / frames);
  for (let i = 0; i < frames; i++) {
    await page.evaluate((s) => window.scrollBy({ top: s, behavior: "instant" }), step);
    await page.waitForTimeout(30);
    await snap(page);
    await page.waitForTimeout(FRAME_MS - 30);
  }
}

async function main() {
  rmSync(FRAMES_DIR, { recursive: true, force: true });
  mkdirSync(FRAMES_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });

  // ── Scene 1: Map (2s) ──
  console.log("Scene 1: Map");
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await hold(page, 2000);

  // ── Scene 2: Click incident → Board (2.5s) ──
  console.log("Scene 2: Board");
  const row = page.locator("[data-incident-id], .incident-strip-row, .lens-map-incident-row").first();
  if (await row.isVisible().catch(() => false)) {
    await row.click({ force: true });
    await hold(page, 1000); // capture zoom transition
  } else {
    await page.goto(`${BASE_URL}/incidents/inc_000002`, { waitUntil: "networkidle" });
  }
  await hold(page, 2500);

  // ── Scene 3: Scroll diagnosis (3s) ──
  console.log("Scene 3: Scroll");
  await scroll(page, 600, 2500);
  await hold(page, 800);

  // ── Scene 4: Scroll back (0.5s) ──
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await hold(page, 800);

  // ── Scene 5: Evidence Studio (2s) ──
  console.log("Scene 4: Evidence Studio");
  await page.evaluate(() =>
    document.querySelector(".lens-board-btn-evidence")
      ?.scrollIntoView({ behavior: "smooth", block: "center" }),
  );
  await hold(page, 500); // capture scroll-into-view
  const evBtn = page.locator("button:has-text('Open Evidence Studio')").first();
  if (await evBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await evBtn.click();
    await hold(page, 1500); // capture zoom transition
    await hold(page, 1500);
  }

  // ── Scene 6: Copilot Q&A (real LLM) ──
  console.log("Scene 5: Copilot Q&A");
  const qa = page.locator(".lens-ev-qa-input").first();
  if (await qa.isVisible().catch(() => false)) {
    await qa.focus();
    await hold(page, 300);
    const q = "What caused the 504 timeout?";
    for (const ch of q) {
      await page.keyboard.type(ch);
      await snap(page);
      await page.waitForTimeout(40);
    }
    await hold(page, 400);
    await page.keyboard.press("Enter");
    console.log("  Waiting for LLM...");
    const t0 = Date.now();
    while (Date.now() - t0 < 20_000) {
      await snap(page);
      await page.waitForTimeout(FRAME_MS);
      const done = await page.evaluate(() => {
        const b = document.querySelectorAll(".lens-ev-qa-bubble-assistant");
        for (const el of b) {
          if (!el.classList.contains("lens-ev-qa-answer-placeholder") &&
              el.textContent && el.textContent.length > 30) return true;
        }
        return false;
      });
      if (done) { console.log("  Response received"); await hold(page, 2500); break; }
    }
  } else {
    await hold(page, 3000);
  }

  await hold(page, 1000);
  await browser.close();
  console.log(`${frameCount} frames captured`);

  // ── GIF encoding ──
  console.log("Encoding GIF...");
  execSync(
    `ffmpeg -y -framerate ${FPS} -i "${FRAMES_DIR}/f%05d.png" ` +
    `-vf "scale=920:-1:flags=lanczos,palettegen=max_colors=256:stats_mode=full" ` +
    `-update 1 "${FRAMES_DIR}/pal.png"`,
    { stdio: "inherit" },
  );
  execSync(
    `ffmpeg -y -framerate ${FPS} -i "${FRAMES_DIR}/f%05d.png" -i "${FRAMES_DIR}/pal.png" ` +
    `-lavfi "scale=920:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=sierra2_4a" ` +
    `-loop 0 "${OUTPUT_GIF}"`,
    { stdio: "inherit" },
  );

  const kb = Math.round(Number(execSync(`stat -f%z "${OUTPUT_GIF}"`).toString().trim()) / 1024);
  console.log(`\nGIF: ${OUTPUT_GIF} (${kb} KB, ${frameCount} frames, ${FPS}fps)`);

  if (kb > 5000) {
    console.log("Too large, reducing...");
    execSync(
      `ffmpeg -y -framerate ${FPS} -i "${FRAMES_DIR}/f%05d.png" ` +
      `-vf "scale=760:-1:flags=lanczos,palettegen=max_colors=192" ` +
      `-update 1 "${FRAMES_DIR}/pal2.png"`,
      { stdio: "inherit" },
    );
    execSync(
      `ffmpeg -y -framerate ${FPS} -i "${FRAMES_DIR}/f%05d.png" -i "${FRAMES_DIR}/pal2.png" ` +
      `-lavfi "scale=760:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=4" ` +
      `-loop 0 "${OUTPUT_GIF}"`,
      { stdio: "inherit" },
    );
    console.log(`Reduced: ${Math.round(Number(execSync(`stat -f%z "${OUTPUT_GIF}"`).toString().trim()) / 1024)} KB`);
  }

  rmSync(FRAMES_DIR, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
