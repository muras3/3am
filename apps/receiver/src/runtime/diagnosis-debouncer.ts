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

/** Cached platform-level waitUntil (Vercel). Per-request is used for CF Workers. */
let cachedPlatformWaitUntil: WaitUntilFn | null = null;

/**
 * Injected per-request waitUntil for platforms that provide it via request context
 * (e.g. CF Workers `ctx.waitUntil`). Set by `setRequestWaitUntil()`, cleared after use.
 */
let requestWaitUntil: WaitUntilFn | null = null;

/**
 * Inject a per-request waitUntil function (e.g. from CF Workers ExecutionContext).
 * Must be called before `resolveWaitUntil()` for the current request.
 */
export function setRequestWaitUntil(fn: WaitUntilFn): void {
  requestWaitUntil = fn;
}

/**
 * Resolve the platform's `waitUntil` function.
 *
 * Priority:
 * 1. Per-request injection (CF Workers `ctx.waitUntil` via `setRequestWaitUntil`)
 * 2. Vercel: `import { waitUntil } from '@vercel/functions'`
 * 3. Local / Node.js fallback: fire-and-forget
 */
export async function resolveWaitUntil(): Promise<WaitUntilFn> {
  // Per-request waitUntil takes priority (CF Workers)
  if (requestWaitUntil) return requestWaitUntil;

  if (cachedPlatformWaitUntil) return cachedPlatformWaitUntil;

  try {
    const mod = await import("@vercel/functions");
    if (typeof mod.waitUntil === "function") {
      cachedPlatformWaitUntil = mod.waitUntil;
      return cachedPlatformWaitUntil;
    }
  } catch {
    // Not on Vercel — fall through to local fallback.
  }

  cachedPlatformWaitUntil = localFallback;
  return cachedPlatformWaitUntil;
}

/** Reset the cached waitUntil — for testing only. */
export function _resetWaitUntilForTest(): void {
  cachedPlatformWaitUntil = null;
  requestWaitUntil = null;
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
 * Execute a diagnosis run after the caller has already claimed dispatch.
 * Keeps the dispatch marker active for the full stage 1 + stage 2 lifecycle,
 * then clears it so read models fall back to ready/unavailable.
 */
export async function runClaimedDiagnosis(
  incidentId: string,
  storage: StorageDriver,
  runner: DiagnosisRunner,
): Promise<void> {
  if (inFlight.has(incidentId)) {
    await storage.releaseDiagnosisDispatch(incidentId);
    return;
  }

  inFlight.add(incidentId);
  try {
    await runner.run(incidentId);
  } finally {
    await storage.releaseDiagnosisDispatch(incidentId);
    inFlight.delete(incidentId);
  }
}

/**
 * Run diagnosis only if no result exists yet AND no run is already in-flight
 * AND this instance wins the DB-level dispatch claim.
 *
 * Three layers of protection against duplicate LLM calls:
 * 1. Process-local `inFlight` Set — prevents TOCTOU race within a single instance
 *    between scheduleDelayedDiagnosis and checkGenerationThreshold.
 * 2. DB-level `claimDiagnosisDispatch` — atomic UPDATE ... WHERE dispatched_at IS NULL
 *    prevents duplicate dispatch across serverless instances.
 * 3. `diagnosisResult` check — skips if diagnosis is already complete.
 */
export async function runIfNeeded(
  incidentId: string,
  storage: StorageDriver,
  runner: DiagnosisRunner,
): Promise<void> {
  if (inFlight.has(incidentId)) return; // Another call is already running in this process.

  const incident = await storage.getIncident(incidentId);
  if (!incident) return;
  if (incident.diagnosisResult) return; // Already diagnosed — skip.

  // DB-level atomic claim: prevents cross-instance duplicate dispatch.
  const claimed = await storage.claimDiagnosisDispatch(incidentId);
  if (!claimed) return; // Another instance already claimed — skip.

  await runClaimedDiagnosis(incidentId, storage, runner);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
