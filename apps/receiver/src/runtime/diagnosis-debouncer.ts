import type { StorageDriver, Incident } from "../storage/interface.js";
import type { DiagnosisRunner } from "./diagnosis-runner.js";
import type { EnqueueDiagnosisFn } from "./diagnosis-dispatch.js";
import { DEFAULT_DIAGNOSIS_LEASE_MS } from "./diagnosis-dispatch.js";

export interface DiagnosisConfig {
  /** Fire when packet generation >= this value. 0 = disabled. */
  generationThreshold: number;
  /** Fire after this many ms from track(), regardless of generation. 0 = disabled. */
  maxWaitMs: number;
}

type WaitUntilFn = (promise: Promise<unknown>) => void;
export type DiagnosisRunOutcome = "succeeded" | "failed" | "skipped";

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
 * Unified freeze predicate for all three diagnosis gate checkpoints.
 *
 * Returns true (allow diagnosis to proceed) when:
 *   - No diagnosisResult exists yet (initial diagnosis path), OR
 *   - A diagnosisResult exists BUT was based on a stale packet generation
 *     (currentGeneration > stored packet_generation) AND no re-diagnosis has
 *     occurred yet (stored packet_generation is defined, meaning it was recorded
 *     with Fix 5.1 and is still behind the current generation).
 *
 * Returns false (freeze / skip) when:
 *   - diagnosisResult already exists and was based on a current or newer packet, OR
 *   - diagnosisResult exists without packet_generation metadata (legacy record) —
 *     treated conservatively as already-up-to-date to avoid infinite re-diagnoses.
 *
 * @param incident - The incident to evaluate. May be null (returns false).
 * @param currentGeneration - The current packet.generation value (from the live packet).
 */
export function shouldAllowRediagnosis(
  incident: Incident | null | undefined,
  currentGeneration: number,
): boolean {
  if (!incident) return false;

  // No prior diagnosis → always allow.
  if (!incident.diagnosisResult) return true;

  // Prior diagnosis exists: check whether it was based on a stale packet.
  // Use optional chaining: legacy or mock records may not have metadata.
  const storedGeneration = incident.diagnosisResult.metadata?.packet_generation;

  // Legacy record without packet_generation: treat conservatively — do not re-diagnose.
  if (storedGeneration === undefined) return false;

  // Allow re-diagnosis when the packet has advanced beyond the stored generation.
  // Design note (Codex review finding): this permits one re-diagnosis per generation
  // advance. Long-lived incidents with many rebuilds could trigger multiple re-diagnoses
  // if the packet keeps advancing. This is the "簡易版" (simplified) approach from the
  // investigation doc — a strict rediagnosis_count cap requires a DB column and is
  // deferred to Fix 5.4. The generation-gap gate is a meaningful improvement over the
  // previous permanent freeze (which never allowed re-diagnosis at all).
  return currentGeneration > storedGeneration;
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
        // Check if diagnosis was already triggered (e.g. by threshold) before running.
        const incident = await storage.getIncident(incidentId);
        const currentGeneration = incident?.packet.generation ?? 1;
        if (!shouldAllowRediagnosis(incident, currentGeneration)) return;
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
  runner: DiagnosisRunner | undefined,
  opts: { generationThreshold: number },
  enqueueDiagnosis?: EnqueueDiagnosisFn,
): void {
  if (opts.generationThreshold > 0 && generation >= opts.generationThreshold) {
    if (enqueueDiagnosis) {
      // Guard against redundant enqueues: skip if diagnosis already up-to-date.
      void (async () => {
        const incident = await storage.getIncident(incidentId);
        if (!shouldAllowRediagnosis(incident, generation)) return;
        await storage.markDiagnosisScheduled(incidentId);
        await enqueueDiagnosis(incidentId);
      })();
    } else if (runner) {
      void runIfNeeded(incidentId, storage, runner);
    }
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
): Promise<Exclude<DiagnosisRunOutcome, "skipped">> {
  if (inFlight.has(incidentId)) {
    await storage.releaseDiagnosisDispatch(incidentId);
    return "failed";
  }

  inFlight.add(incidentId);
  try {
    const ok = await runner.run(incidentId);
    if (!ok) {
      // Diagnosis failed silently — clear scheduled state so UI shows "unavailable"
      // rather than leaving it stuck in "pending" forever.
      await storage.clearDiagnosisScheduled(incidentId);
    }
    return ok ? "succeeded" : "failed";
  } catch (err) {
    await storage.clearDiagnosisScheduled(incidentId);
    throw err;
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
): Promise<DiagnosisRunOutcome> {
  if (inFlight.has(incidentId)) return "skipped"; // Another call is already running in this process.

  const incident = await storage.getIncident(incidentId);
  if (!incident) return "skipped";
  const currentGeneration = incident.packet.generation ?? 1;
  if (!shouldAllowRediagnosis(incident, currentGeneration)) return "skipped"; // Already diagnosed with current packet — skip.

  // DB-level atomic claim: prevents cross-instance duplicate dispatch.
  const claimed = await storage.claimDiagnosisDispatch(incidentId, DEFAULT_DIAGNOSIS_LEASE_MS);
  if (!claimed) return "skipped"; // Another instance already claimed — skip.

  return runClaimedDiagnosis(incidentId, storage, runner);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
