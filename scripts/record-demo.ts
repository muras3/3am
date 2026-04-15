/**
 * Record a high-fidelity demo of the 3am Console UI in three formats
 * (MP4, WebM, GIF) from the same PNG frame sequence.
 *
 * What you see:
 *   1. Incident list                                        ~1.6 s
 *   2. Click an incident → Incident Board                   ~2.0 s
 *   3. Click "Open Evidence Studio" → Evidence Studio       ~1.6 s
 *   4. Type a question in the AI Copilot input → submit →
 *      pending → streamed assistant answer (faked locally,
 *      no LLM call)                                          ~5.0 s
 *
 * A synthetic cursor is injected into every page so navigation reads as
 * a real user. Cursor moves are interleaved with frame snapshots so the
 * recording captures the motion (page.mouse.move() alone is async and
 * would teleport between snapshots).
 *
 * Usage:
 *   pnpm tsx scripts/record-demo.ts
 *
 *   pnpm tsx scripts/record-demo.ts --with-copilot=live
 *     # use the live receiver/LLM for the Copilot answer instead of the
 *     # local fake (requires ANTHROPIC_API_KEY on the receiver).
 *
 * Prerequisites:
 *   - Receiver running on localhost:3333 with seed data
 *     (apps/receiver/src/scripts/seed-dev.ts).
 *   - The script navigates to inc_000002 (cascading-timeout scenario).
 */
import { chromium, type Locator, type Page } from "playwright";
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
const VIEWPORT = { width: 920, height: 600 };
const DEVICE_SCALE_FACTOR = 2;
const FPS = 30;
const FRAME_MS = Math.round(1000 / FPS);

const COPILOT_MODE =
  process.argv.find((a) => a.startsWith("--with-copilot="))?.split("=")[1] ??
  "fake"; // "fake" (default) | "live"
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

// ─── Synthetic cursor ────────────────────────────────────────────────
//
// addInitScript() persists across page.goto() so every navigation gets
// the cursor. The cursor follows real `mousemove` events fired by
// page.mouse.move(), so we can drive it with the standard Playwright
// API. mousedown/up trigger a brief scale-pulse animation.
const CURSOR_INIT_SCRIPT = `
(() => {
  if (window.__demoCursorInstalled) return;
  window.__demoCursorInstalled = true;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const start = () => {
    if (!document.body) {
      requestAnimationFrame(start);
      return;
    }
    const wrap = document.createElement("div");
    wrap.id = "__demo-cursor";
    Object.assign(wrap.style, {
      position: "fixed",
      left: "0px",
      top: "0px",
      width: "28px",
      height: "28px",
      pointerEvents: "none",
      zIndex: "2147483647",
      transform: "translate(460px, 300px)",
      transition: "transform 30ms linear",
      willChange: "transform",
    });
    // macOS-style arrow cursor in white with a dark outline so it reads on
    // both warm-light surfaces and dark accent panels.
    wrap.innerHTML = \`
      <svg xmlns="\${SVG_NS}" width="28" height="28" viewBox="0 0 28 28">
        <path d="M5 3 L5 22 L11 17 L14.5 25 L18 23.5 L14.5 15.5 L21 15.5 Z"
              fill="#FFFFFF" stroke="#1A1A1A" stroke-width="1.4"
              stroke-linejoin="round"/>
      </svg>
      <div id="__demo-cursor-pulse" style="
        position: absolute; inset: 0;
        border: 2px solid #E85D3A;
        border-radius: 50%;
        opacity: 0;
        transform: scale(0.6);
        transition: transform 200ms ease-out, opacity 220ms ease-out;
      "></div>
    \`;
    document.body.appendChild(wrap);
    window.__cursorX = 460;
    window.__cursorY = 300;
    document.addEventListener("mousemove", (e) => {
      window.__cursorX = e.clientX;
      window.__cursorY = e.clientY;
      wrap.style.transform = \`translate(\${e.clientX}px, \${e.clientY}px)\`;
    }, { capture: true, passive: true });
    document.addEventListener("mousedown", () => {
      const pulse = wrap.querySelector("#__demo-cursor-pulse");
      if (!pulse) return;
      pulse.style.opacity = "1";
      pulse.style.transform = "scale(1.6)";
    }, { capture: true, passive: true });
    document.addEventListener("mouseup", () => {
      const pulse = wrap.querySelector("#__demo-cursor-pulse");
      if (!pulse) return;
      pulse.style.opacity = "0";
      pulse.style.transform = "scale(0.6)";
    }, { capture: true, passive: true });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
`;

async function smoothMoveTo(page: Page, x: number, y: number, durationMs: number) {
  const from = await page.evaluate(() => ({
    x: (window as unknown as { __cursorX?: number }).__cursorX ?? 460,
    y: (window as unknown as { __cursorY?: number }).__cursorY ?? 300,
  }));
  const steps = Math.max(2, Math.round(durationMs / FRAME_MS));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // ease-out cubic — natural deceleration as the cursor lands.
    const ease = 1 - Math.pow(1 - t, 3);
    const cx = from.x + (x - from.x) * ease;
    const cy = from.y + (y - from.y) * ease;
    await page.mouse.move(cx, cy);
    await snap(page);
  }
}

async function moveToLocator(page: Page, locator: Locator, durationMs = 600) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`No bounding box for locator: ${locator}`);
  await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2, durationMs);
}

async function clickWithFeedback(
  page: Page,
  locator: Locator,
  opts: { approachMs?: number; postClickHoldMs?: number } = {},
) {
  const approachMs = opts.approachMs ?? 700;
  const postClickHoldMs = opts.postClickHoldMs ?? 1500;
  await moveToLocator(page, locator, approachMs);
  await hold(page, 200); // brief settle on target
  await page.mouse.down();
  await snap(page);
  await page.waitForTimeout(60);
  await snap(page);
  await page.mouse.up();
  await snap(page);
  // Real navigation/state change — let the UI repaint then dwell.
  await page.waitForTimeout(120);
  await hold(page, postClickHoldMs);
}

// ─── Faked Copilot response ──────────────────────────────────────────
//
// The /api/incidents/.../evidence/query endpoint returns a single
// JSON payload (not a stream). When --with-copilot=fake we intercept
// that request and:
//   1. delay the response ~1.5 s so the pending spinner is visible
//   2. return a hand-crafted EvidenceQueryResponse with two fact
//      segments that match the cascading-timeout scenario
// Then, after the bubble renders, we rewrite each segment's text
// character-by-character via page.evaluate() so a "streaming" effect
// is visible in the recording.
const FAKE_RESPONSE = {
  status: "answered",
  segments: [
    {
      kind: "fact",
      text: "notification-svc latency rose from ~100ms to ~8s while web /api/orders kept its 2s HTTP timeout, so the upstream call exceeded the budget on every retry.",
      evidenceRefs: [{ kind: "span", id: "trace:web:/api/orders" }],
    },
    {
      kind: "fact",
      text: "Worker pool saturated within seconds because each request held a slot waiting on the slow downstream call — that's why /checkout cascaded to 504.",
      evidenceRefs: [{ kind: "metric", id: "worker_pool_saturation" }],
    },
  ],
  evidenceRefs: [],
  followups: [
    {
      question: "What changed in notification-svc around the latency jump?",
      targetEvidenceKinds: ["log_cluster", "metric"],
    },
  ],
};

async function streamFakeAnswer(page: Page) {
  await page.waitForSelector(
    ".lens-ev-qa-thread .lens-ev-qa-bubble-assistant .lens-ev-qa-segments",
    { timeout: 5000 },
  );
  const targets = await page.$$eval(
    ".lens-ev-qa-thread .lens-ev-qa-bubble-assistant .lens-ev-qa-segment-text",
    (els) => els.map((el) => el.textContent ?? ""),
  );
  // Reset segment text to empty so the bubble appears with placeholders
  // and the text writes in.
  await page.evaluate(() => {
    document
      .querySelectorAll(
        ".lens-ev-qa-thread .lens-ev-qa-bubble-assistant .lens-ev-qa-segment-text",
      )
      .forEach((el) => {
        el.textContent = "";
      });
  });
  await snap(page);
  // Drip characters across all segments. ~2 s total stream time.
  const totalChars = targets.reduce((n, s) => n + s.length, 0);
  const targetMs = 2000;
  const chunksPerFrame = Math.max(2, Math.ceil(totalChars / (targetMs / FRAME_MS)));
  const pos = targets.map(() => 0);
  for (;;) {
    let done = true;
    for (let i = 0; i < targets.length; i++) {
      if (pos[i] < targets[i].length) {
        done = false;
        pos[i] = Math.min(targets[i].length, pos[i] + chunksPerFrame);
      }
    }
    await page.evaluate(
      ({ slices }: { slices: string[] }) => {
        const els = document.querySelectorAll(
          ".lens-ev-qa-thread .lens-ev-qa-bubble-assistant .lens-ev-qa-segment-text",
        );
        els.forEach((el, idx) => {
          el.textContent = slices[idx] ?? "";
        });
      },
      { slices: targets.map((s, i) => s.slice(0, pos[i])) },
    );
    await snap(page);
    if (done) break;
    await page.waitForTimeout(FRAME_MS);
  }
}

// ─── Recording timeline ──────────────────────────────────────────────
async function main() {
  rmSync(FRAMES_DIR, { recursive: true, force: true });
  mkdirSync(FRAMES_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
  });

  await context.addInitScript(CURSOR_INIT_SCRIPT);

  // Tighten transitions so the clip stays brisk without looking abrupt.
  await context.addInitScript(`
    (() => {
      const inject = () => {
        if (!document.head) { requestAnimationFrame(inject); return; }
        const s = document.createElement("style");
        s.textContent = "* { animation-duration: 250ms !important; transition-duration: 180ms !important; }";
        document.head.appendChild(s);
      };
      inject();
    })();
  `);

  if (COPILOT_MODE === "fake") {
    await context.route("**/api/incidents/**/evidence/query", async (route) => {
      // Hold the request briefly so the UI shows the "pending" spinner.
      await new Promise((r) => setTimeout(r, 1500));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(FAKE_RESPONSE),
      });
    });
  }

  const page = await context.newPage();

  // ── Scene 1: Incident list ──
  console.log("Scene 1: Incident list");
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  // Park the cursor in the upper-left so its first move into the page is
  // visible (rather than starting on top of the eventual click target).
  await page.mouse.move(60, 80);
  await hold(page, 1600);

  // ── Scene 2: Click an incident row → Incident Board ──
  console.log("Scene 2: Approach + click incident row → Board");
  let incidentRow = page
    .locator(
      `[data-incident-id="${INCIDENT_ID}"], [data-incident-id*="${INCIDENT_ID}"]`,
    )
    .first();
  if (!(await incidentRow.isVisible().catch(() => false))) {
    incidentRow = page
      .locator(".incident-strip-row, .lens-map-incident-row, [data-incident-id]")
      .first();
  }
  if (await incidentRow.isVisible().catch(() => false)) {
    await clickWithFeedback(page, incidentRow, {
      approachMs: 800,
      postClickHoldMs: 600,
    });
  } else {
    await page.goto(`${BASE_URL}/incidents/${INCIDENT_ID}`, {
      waitUntil: "networkidle",
    });
  }
  await page.waitForURL(/\/incidents\//, { timeout: 4000 }).catch(async () => {
    await page.goto(`${BASE_URL}/incidents/${INCIDENT_ID}`, {
      waitUntil: "networkidle",
    });
  });
  await hold(page, 1500);

  // ── Scene 3: Click "Open Evidence Studio" → Evidence Studio ──
  console.log("Scene 3: Approach + click Evidence Studio button");
  const evBtn = page.locator("button:has-text('Open Evidence Studio')").first();
  if (await evBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await evBtn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await clickWithFeedback(page, evBtn, {
      approachMs: 700,
      postClickHoldMs: 1600,
    });
  } else {
    await hold(page, 1600);
  }

  // ── Scene 4: AI Copilot Q&A ──
  console.log("Scene 4: Copilot Q&A");
  const qaInput = page.locator(".lens-ev-qa-input").first();
  await qaInput.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  await moveToLocator(page, qaInput, 700);
  // Click to focus.
  await page.mouse.down();
  await snap(page);
  await page.mouse.up();
  await snap(page);
  await qaInput.focus();
  await hold(page, 250);

  const question = "Why did /api/orders cascade to 504s?";
  for (const ch of question) {
    await page.keyboard.type(ch);
    await snap(page);
    await page.waitForTimeout(55);
  }
  await hold(page, 350);

  // Move to the submit button and click it.
  const submitBtn = page.locator(".lens-ev-qa-submit").first();
  if (await submitBtn.isVisible().catch(() => false)) {
    await moveToLocator(page, submitBtn, 450);
    await hold(page, 120);
    await page.mouse.down();
    await snap(page);
    await page.waitForTimeout(60);
    await page.mouse.up();
    await snap(page);
    // Defensive: if the click didn't trigger submit (rare), submit
    // programmatically — no-op when the click already worked.
    await page.evaluate(() => {
      const form = document.querySelector(
        ".lens-ev-qa-form",
      ) as HTMLFormElement | null;
      form?.requestSubmit?.();
    });
  } else {
    await page.keyboard.press("Enter");
    await snap(page);
  }

  // Capture the pending state ("Checking…") for ~1.4 s — the route stub
  // delays the response by 1.5 s.
  await hold(page, 1400);

  if (COPILOT_MODE === "fake") {
    console.log("  Streaming faked assistant answer…");
    await streamFakeAnswer(page);
    await hold(page, 900);
  } else {
    console.log("  Waiting for live LLM response…");
    const t0 = Date.now();
    while (Date.now() - t0 < 20_000) {
      await snap(page);
      await page.waitForTimeout(FRAME_MS);
      const done = await page.evaluate(() => {
        const els = document.querySelectorAll(
          ".lens-ev-qa-thread .lens-ev-qa-bubble-assistant .lens-ev-qa-segment-text",
        );
        for (const el of els) {
          if (el.textContent && el.textContent.length > 30) return true;
        }
        return false;
      });
      if (done) {
        await hold(page, 1800);
        break;
      }
    }
  }

  await browser.close();
  console.log(
    `${frameCount} frames captured at ${FPS}fps (${(frameCount / FPS).toFixed(1)}s)`,
  );

  // ─── Encoding ──────────────────────────────────────────────────────
  const encodeWidth = 1840; // viewport 920 × DPR 2
  const totalSec = frameCount / FPS;
  const fadeOutStart = Math.max(0, totalSec - 0.2);
  const fadeFilter = `fade=t=in:st=0:d=0.2:color=0xFAFAF8,fade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.2:color=0xFAFAF8`;

  console.log("Encoding MP4…");
  execSync(
    `ffmpeg -y -framerate ${FPS} -i "${FRAMES_DIR}/f%05d.png" ` +
      `-vf "scale=${encodeWidth}:-2:flags=lanczos,${fadeFilter},format=yuv420p" ` +
      `-c:v libx264 -preset slow -crf 22 -profile:v main -level 4.0 ` +
      `-movflags +faststart "${OUT_MP4}"`,
    { stdio: "inherit" },
  );

  console.log("Encoding WebM (VP9)…");
  execSync(
    `ffmpeg -y -framerate ${FPS} -i "${FRAMES_DIR}/f%05d.png" ` +
      `-vf "scale=${encodeWidth}:-2:flags=lanczos,${fadeFilter}" ` +
      `-c:v libvpx-vp9 -b:v 0 -crf 32 -row-mt 1 -tile-columns 2 ` +
      `"${OUT_WEBM}"`,
    { stdio: "inherit" },
  );

  console.log("Encoding GIF (2-pass palette)…");
  const gifWidth = 920;
  execSync(
    `ffmpeg -y -framerate ${FPS} -i "${FRAMES_DIR}/f%05d.png" ` +
      `-vf "fps=15,scale=${gifWidth}:-1:flags=lanczos,${fadeFilter},palettegen=max_colors=256:stats_mode=full" ` +
      `-update 1 "${FRAMES_DIR}/pal.png"`,
    { stdio: "inherit" },
  );
  execSync(
    `ffmpeg -y -framerate ${FPS} -i "${FRAMES_DIR}/f%05d.png" -i "${FRAMES_DIR}/pal.png" ` +
      `-lavfi "fps=15,scale=${gifWidth}:-1:flags=lanczos,${fadeFilter} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5" ` +
      `-loop 0 "${OUT_GIF}"`,
    { stdio: "inherit" },
  );

  const sizeKB = (p: string) => Math.round(statSync(p).size / 1024);
  console.log("\nOutputs:");
  console.log(`  MP4  : ${OUT_MP4} (${sizeKB(OUT_MP4)} KB)`);
  console.log(`  WebM : ${OUT_WEBM} (${sizeKB(OUT_WEBM)} KB)`);
  console.log(`  GIF  : ${OUT_GIF}  (${sizeKB(OUT_GIF)} KB)`);

  if (sizeKB(OUT_GIF) > 2000) {
    console.log("GIF over 2 MB, re-encoding at 760 px / 192 colors / 12 fps…");
    execSync(
      `ffmpeg -y -framerate ${FPS} -i "${FRAMES_DIR}/f%05d.png" ` +
        `-vf "fps=12,scale=760:-1:flags=lanczos,${fadeFilter},palettegen=max_colors=192" ` +
        `-update 1 "${FRAMES_DIR}/pal2.png"`,
      { stdio: "inherit" },
    );
    execSync(
      `ffmpeg -y -framerate ${FPS} -i "${FRAMES_DIR}/f%05d.png" -i "${FRAMES_DIR}/pal2.png" ` +
        `-lavfi "fps=12,scale=760:-1:flags=lanczos,${fadeFilter} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=4" ` +
        `-loop 0 "${OUT_GIF}"`,
      { stdio: "inherit" },
    );
    console.log(`  GIF  : reduced to ${sizeKB(OUT_GIF)} KB`);
  }

  // Refresh static hero poster from a Board frame (~3 s in).
  try {
    const posterFrame = String(Math.min(frameCount - 1, FPS * 3)).padStart(5, "0");
    execSync(
      `ffmpeg -y -i "${FRAMES_DIR}/f${posterFrame}.png" -vf "scale=${encodeWidth}:-2:flags=lanczos" "${HERO_POSTER}"`,
      { stdio: "inherit" },
    );
    console.log(`  PNG  : ${HERO_POSTER} refreshed`);
  } catch {
    // Non-fatal.
  }

  rmSync(FRAMES_DIR, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
