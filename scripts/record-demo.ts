/**
 * Record a high-fidelity demo of the 3am Console UI in three formats
 * (MP4, WebM, GIF) from the same PNG frame sequence, so each one is
 * color-identical to the product.
 *
 * Flow: Incident list → Board (root cause + causal chain) → scroll →
 *       Evidence Studio → optional Copilot Q&A (--with-copilot)
 *
 * Usage:
 *   # default: no LLM calls, skips Copilot scene
 *   pnpm tsx scripts/record-demo.ts
 *
 *   # include the live Copilot Q&A scene (requires ANTHROPIC_API_KEY)
 *   pnpm tsx scripts/record-demo.ts --with-copilot
 *
 * Prerequisites:
 *   - Receiver running on localhost:3333 with seed data
 *     (see apps/receiver/src/scripts/seed-dev.ts). The script
 *     navigates to inc_000002 (cascading-timeout scenario).
 */
import { chromium, type Page } from "playwright";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = join(__dirname, "../assets");
const FRAMES_DIR = join(ASSETS_DIR, "frames-tmp");
const OUT_MP4 = join(ASSETS_DIR, "demo.mp4");
const OUT_WEBM = join(ASSETS_DIR, "demo.webm");
const OUT_GIF = join(ASSETS_DIR, "demo.gif");
const HERO_POSTER = join(ASSETS_DIR, "frames", "frame_0002.png");

const BASE_URL = process.env["DEMO_BASE_URL"] ?? "http://localhost:3333";
// Capture at 2x logical resolution so the final 1840-wide output is sharp on
// Retina. Logical viewport is 920x600 to match the existing layout density.
const VIEWPORT = { width: 920, height: 600 };
const DEVICE_SCALE_FACTOR = 2;
const FPS = 30;
const FRAME_MS = Math.round(1000 / FPS);

const WITH_COPILOT = process.argv.includes("--with-copilot");
const INCIDENT_ID = process.env["DEMO_INCIDENT_ID"] ?? "inc_000002";

let frameCount = 0;

async function snap(page: Page) {
  await page.screenshot({
    path: join(FRAMES_DIR, `f${String(frameCount++).padStart(5, "0")}.png`),
  });
}

async function hold(page: Page, ms: number) {
  const n = Math.max(1, Math.round(ms / FRAME_MS));
  for (let i = 0; i < n; i++) {
    await snap(page);
    if (i < n - 1) await page.waitForTimeout(FRAME_MS);
  }
}

async function scroll(page: Page, distance: number, durationMs: number) {
  const frames = Math.max(1, Math.round(durationMs / FRAME_MS));
  const step = Math.round(distance / frames);
  for (let i = 0; i < frames; i++) {
    await page.evaluate((s) => window.scrollBy({ top: s, behavior: "instant" }), step);
    await page.waitForTimeout(Math.min(20, FRAME_MS - 2));
    await snap(page);
  }
}

async function main() {
  rmSync(FRAMES_DIR, { recursive: true, force: true });
  mkdirSync(FRAMES_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
  });

  // Speed up any CSS transitions without disabling them (keeps the look
  // polished while keeping the clip short).
  await page.addStyleTag({
    content: `* { animation-duration: 250ms !important; transition-duration: 180ms !important; }`,
  });

  // Fixed 3-scene timeline, total ≤ 7s, each screen visible ≥ 1s.
  //   Scene 1  Incident list .................. 1.8s
  //   Scene 2  Incident Board (3-col diagnosis) 2.4s
  //   Scene 3  Evidence Studio ................. 2.4s
  //   -------------------------------------------------
  //   total                                     6.6s
  // Transitions are driven by real navigation + our global CSS override that
  // shortens animations uniformly, so movement reads as smooth without jank.

  // ── Scene 1: Incident list landing ──
  console.log("Scene 1: Incident list");
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await hold(page, 1800);

  // ── Scene 2: Incident Board (3-column) ──
  console.log("Scene 2: Incident Board");
  const row = page
    .locator(
      "[data-incident-id], .incident-strip-row, .lens-map-incident-row",
    )
    .first();
  if (await row.isVisible().catch(() => false)) {
    await row.click({ force: true });
    await hold(page, 300);
  }
  await page.goto(`${BASE_URL}/incidents/${INCIDENT_ID}`, {
    waitUntil: "networkidle",
  });
  await hold(page, 2400);

  // ── Scene 3: Evidence Studio ──
  console.log("Scene 3: Evidence Studio");
  await page.evaluate(() =>
    document
      .querySelector(".lens-board-btn-evidence")
      ?.scrollIntoView({ behavior: "smooth", block: "center" }),
  );
  await hold(page, 200);
  const evBtn = page.locator("button:has-text('Open Evidence Studio')").first();
  if (await evBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await evBtn.click();
  }
  await hold(page, 2200);

  // Copilot Q&A (live LLM) only when explicitly opted in. Kept here so the
  // same script can drive a longer marketing reel when ANTHROPIC_API_KEY is set.
  if (WITH_COPILOT) {
    console.log("Bonus: Copilot Q&A (live LLM)");
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
      console.log("  Waiting for LLM response…");
      const t0 = Date.now();
      while (Date.now() - t0 < 20_000) {
        await snap(page);
        await page.waitForTimeout(FRAME_MS);
        const done = await page.evaluate(() => {
          const b = document.querySelectorAll(".lens-ev-qa-bubble-assistant");
          for (const el of b) {
            if (
              !el.classList.contains("lens-ev-qa-answer-placeholder") &&
              el.textContent &&
              el.textContent.length > 30
            )
              return true;
          }
          return false;
        });
        if (done) {
          console.log("  Response received");
          await hold(page, 2000);
          break;
        }
      }
    }
  }

  await browser.close();
  console.log(`${frameCount} frames captured at ${FPS}fps`);

  // Output dimensions: logical 920x600 captured at 2x → 1840x1200 PNGs.
  // Scale the video outputs to 1840 to preserve sharpness.
  const encodeWidth = 1840;

  // Loop-seam handling: fade in from --bg at the start and fade out to --bg
  // at the end. The fade is 200ms on each side — long enough to mask the
  // scene-1 → scene-3 jump when the clip loops, short enough that the hold
  // time on each scene is preserved.
  const totalSec = frameCount / FPS;
  const fadeOutStart = Math.max(0, totalSec - 0.2);
  const fadeFilter = `fade=t=in:st=0:d=0.2:color=0xFAFAF8,fade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.2:color=0xFAFAF8`;

  // ── 1) MP4 (H.264 main profile, web-safe pixel format, fast start) ──
  console.log("Encoding MP4…");
  execSync(
    `ffmpeg -y -framerate ${FPS} -i "${FRAMES_DIR}/f%05d.png" ` +
      `-vf "scale=${encodeWidth}:-2:flags=lanczos,${fadeFilter},format=yuv420p" ` +
      `-c:v libx264 -preset slow -crf 22 -profile:v main -level 4.0 ` +
      `-movflags +faststart ` +
      `"${OUT_MP4}"`,
    { stdio: "inherit" },
  );

  // ── 2) WebM (VP9) ──
  console.log("Encoding WebM (VP9)…");
  execSync(
    `ffmpeg -y -framerate ${FPS} -i "${FRAMES_DIR}/f%05d.png" ` +
      `-vf "scale=${encodeWidth}:-2:flags=lanczos,${fadeFilter}" ` +
      `-c:v libvpx-vp9 -b:v 0 -crf 32 -row-mt 1 -tile-columns 2 ` +
      `"${OUT_WEBM}"`,
    { stdio: "inherit" },
  );

  // ── 3) GIF (2-pass palette) — render at 920px for size budget ──
  console.log("Encoding GIF (2-pass palette)…");
  const gifWidth = 920;
  // GIF runs at 15fps, so the fade expressed in seconds still works.
  const gifFade = `fade=t=in:st=0:d=0.2:color=0xFAFAF8,fade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.2:color=0xFAFAF8`;
  execSync(
    `ffmpeg -y -framerate ${FPS} -i "${FRAMES_DIR}/f%05d.png" ` +
      `-vf "fps=15,scale=${gifWidth}:-1:flags=lanczos,${gifFade},palettegen=max_colors=256:stats_mode=full" ` +
      `-update 1 "${FRAMES_DIR}/pal.png"`,
    { stdio: "inherit" },
  );
  execSync(
    `ffmpeg -y -framerate ${FPS} -i "${FRAMES_DIR}/f%05d.png" -i "${FRAMES_DIR}/pal.png" ` +
      `-lavfi "fps=15,scale=${gifWidth}:-1:flags=lanczos,${gifFade} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5" ` +
      `-loop 0 "${OUT_GIF}"`,
    { stdio: "inherit" },
  );

  const sizeKB = (p: string) => Math.round(statSync(p).size / 1024);
  console.log("\nOutputs:");
  console.log(`  MP4  : ${OUT_MP4} (${sizeKB(OUT_MP4)} KB)`);
  console.log(`  WebM : ${OUT_WEBM} (${sizeKB(OUT_WEBM)} KB)`);
  console.log(`  GIF  : ${OUT_GIF}  (${sizeKB(OUT_GIF)} KB)`);

  // If GIF is over budget, downsize to 760 with a lighter palette.
  if (sizeKB(OUT_GIF) > 2000) {
    console.log("GIF over budget (>2MB), re-encoding at 760px with 192 colors…");
    execSync(
      `ffmpeg -y -framerate ${FPS} -i "${FRAMES_DIR}/f%05d.png" ` +
        `-vf "fps=12,scale=760:-1:flags=lanczos,${gifFade},palettegen=max_colors=192" ` +
        `-update 1 "${FRAMES_DIR}/pal2.png"`,
      { stdio: "inherit" },
    );
    execSync(
      `ffmpeg -y -framerate ${FPS} -i "${FRAMES_DIR}/f%05d.png" -i "${FRAMES_DIR}/pal2.png" ` +
        `-lavfi "fps=12,scale=760:-1:flags=lanczos,${gifFade} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=4" ` +
        `-loop 0 "${OUT_GIF}"`,
      { stdio: "inherit" },
    );
    console.log(`  GIF  : reduced to ${sizeKB(OUT_GIF)} KB`);
  }

  // Refresh the static hero poster (used as README fallback image) from an
  // early frame that shows the incident board.
  try {
    execSync(
      `ffmpeg -y -i "${FRAMES_DIR}/f00060.png" -vf "scale=${encodeWidth}:-2:flags=lanczos" "${HERO_POSTER}"`,
      { stdio: "inherit" },
    );
    console.log(`  PNG  : ${HERO_POSTER} refreshed`);
  } catch {
    // Non-fatal: if the specific frame doesn't exist, leave the existing poster in place.
  }

  rmSync(FRAMES_DIR, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
