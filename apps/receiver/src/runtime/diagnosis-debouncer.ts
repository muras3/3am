import type { StorageDriver } from "../storage/interface.js";
import type { DiagnosisRunner } from "./diagnosis-runner.js";

export interface DiagnosisConfig {
  /** Fire when packet generation >= this value. 0 = disabled. */
  generationThreshold: number;
  /** Fire after this many ms from track(), regardless of generation. 0 = disabled. */
  maxWaitMs: number;
}

type WaitUntilFn = (promise: Promise<unknown>) => void;

/**
 * In-flight guard: tracks incidentIds that currently have a diagnosis run
 * in progress. Prevents the TOCTOU race where both scheduleDelayedDiagnosis
 * and checkGenerationThreshold observe no diagnosisResult and both call
 * runner.run() concurrently.
 */
const inFlight = new Set<string>();

/** Reset in-flight guard — for testing only. */
export function _resetInFlightForTest(): void {
  inFlight.clear();
}

/** Local Node.js fallback: fire-and-forget (no serverless lifecycle guarantee). */
const localFallback: WaitUntilFn = (promise) => { void promise; };

/** Cached waitUntil function — resolved once on first use. */
let cachedWaitUntil: WaitUntilFn | null = null;

/**
 * Resolve the platform's `waitUntil` function (cached after first call).
 *
 * - Vercel: `import { waitUntil } from '@vercel/functions'`
 * - Local / Node.js fallback: fire-and-forget
 */
export async function resolveWaitUntil(): Promise<WaitUntilFn> {
  if (cachedWaitUntil) return cachedWaitUntil;

  try {
    const mod = await import("@vercel/functions");
    if (typeof mod.waitUntil === "function") {
      cachedWaitUntil = mod.waitUntil;
      return cachedWaitUntil;
    }
  } catch {
    // Not on Vercel — fall through to local fallback.
  }

  cachedWaitUntil = localFallback;
  return cachedWaitUntil;
}

/** Reset the cached waitUntil — for testing only. */
export function _resetWaitUntilForTest(): void {
  cachedWaitUntil = null;
}

/**
 * Schedule a delayed diagnosis using platform-native `waitUntil`.
 *
 * After `maxWaitMs` elapses, checks whether diagnosis has already been
 * produced for this incident (idempotency) and runs if not.
 *
 * Called when a new incident is created and the debouncer is active.
 *
 * @param waitUntilFn - Pre-resolved waitUntil function (from resolveWaitUntil at app startup).
 */
export function scheduleDelayedDiagnosis(
  incidentId: string,
  storage: StorageDriver,
  runner: DiagnosisRunner,
  opts: { maxWaitMs: number },
  waitUntilFn: WaitUntilFn,
): void {
  waitUntilFn(
    (async () => {
      try {
        await sleep(opts.maxWaitMs);
        await runIfNeeded(incidentId, storage, runner);
      } catch (err) {
        // Prevent unhandled rejection when waitUntil is fire-and-forget.
        // DiagnosisRunner.run() handles its own errors, but guard defensively.
        console.error(`[diagnosis-debouncer] delayed diagnosis failed for ${incidentId}:`, err);
      }
    })(),
  );
}

/**
 * Check whether the generation threshold has been reached.
 * If so, run diagnosis immediately (no waitUntil needed).
 *
 * Called after every rebuildSnapshots to check if enough evidence has accumulated.
 */
export function checkGenerationThreshold(
  incidentId: string,
  generation: number,
  storage: StorageDriver,
  runner: DiagnosisRunner,
  opts: { generationThreshold: number },
): void {
  if (opts.generationThreshold > 0 && generation >= opts.generationThreshold) {
    void runIfNeeded(incidentId, storage, runner);
  }
}

/**
 * Run diagnosis only if no result exists yet AND no run is already in-flight.
 *
 * The in-flight Set prevents the TOCTOU race between scheduleDelayedDiagnosis
 * (delayed path) and checkGenerationThreshold (immediate path): without it,
 * both can observe diagnosisResult === undefined at the same time and both
 * proceed to call runner.run(), causing duplicate LLM calls.
 *
 * DiagnosisRunner.run() itself also checks for ANTHROPIC_API_KEY and incident
 * existence, so this is an additional layer to prevent redundant LLM calls.
 */
async function runIfNeeded(
  incidentId: string,
  storage: StorageDriver,
  runner: DiagnosisRunner,
): Promise<void> {
  if (inFlight.has(incidentId)) return; // Another call is already running.

  const incident = await storage.getIncident(incidentId);
  if (!incident) return;
  if (incident.diagnosisResult) return; // Already diagnosed — skip.

  inFlight.add(incidentId);
  try {
    await runner.run(incidentId);
  } finally {
    inFlight.delete(incidentId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
