import type { StorageDriver } from "../storage/interface.js";
import type { DiagnosisRunner } from "./diagnosis-runner.js";
import type { EnqueueDiagnosisFn } from "./diagnosis-dispatch.js";
import { DEFAULT_DIAGNOSIS_LEASE_MS } from "./diagnosis-dispatch.js";

/**
 * Minimum age (ms) for a diagnosis_scheduled_at timestamp before the incident
 * is considered a potential orphan. 45s = 30s timer + 15s buffer.
 */
export const ORPHAN_SCHEDULED_THRESHOLD_MS = 45_000;

/**
 * Throttle interval (ms) for orphan recovery checks on the ingest path.
 * Prevents every single ingest request from running a DB scan.
 */
export const ORPHAN_CHECK_INTERVAL_MS = 10_000;

export interface DiagnosisConfig {
  /** Fire when packet generation >= this value. 0 = disabled. */
  generationThreshold: number;
  /** Fire after this many ms from track(), regardless of generation. 0 = disabled. */
  maxWaitMs: number;
}

export type WaitUntilFn = (promise: Promise<unknown>) => void;
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

/** Last time orphan recovery was run (module-level throttle). */
let lastOrphanCheckMs = 0;

/** Reset orphan check throttle — for testing only. */
export function _resetOrphanCheckForTest(): void {
  lastOrphanCheckMs = 0;
}

/**
 * Best-effort orphan recovery for the Vercel path.
 *
 * When Vercel recycles a serverless instance mid-timer, the waitUntil+sleep
 * promise is lost and diagnosis never fires. On the next ingest request we
 * scan for incidents that look like orphans:
 *   - diagnosis_scheduled_at IS NOT NULL (timer was started)
 *   - diagnosisResult IS NULL (diagnosis never completed)
 *   - diagnosisDispatchedAt IS NULL (not currently in-flight)
 *     OR diagnosisDispatchedAt is older than DEFAULT_DIAGNOSIS_LEASE_MS (stale lease)
 *   - diagnosis_scheduled_at is older than ORPHAN_SCHEDULED_THRESHOLD_MS
 *
 * For each orphan, `runIfNeeded` (with its atomic DB claim) is called inside
 * waitUntil so Vercel keeps the instance alive until diagnosis completes.
 *
 * Throttled to at most once per ORPHAN_CHECK_INTERVAL_MS to avoid a full
 * DB scan on every single ingest request.
 */
export function recoverOrphanedDiagnoses(
  storage: StorageDriver,
  runner: DiagnosisRunner,
  waitUntilFn: WaitUntilFn,
  now: number = Date.now(),
): void {
  if (now - lastOrphanCheckMs < ORPHAN_CHECK_INTERVAL_MS) return;
  lastOrphanCheckMs = now;

  waitUntilFn(
    (async () => {
      try {
        const page = await storage.listIncidents({ limit: 100 });
        const cutoff = now - ORPHAN_SCHEDULED_THRESHOLD_MS;
        const leaseCutoff = now - DEFAULT_DIAGNOSIS_LEASE_MS;

        for (const incident of page.items) {
          if (!incident.diagnosisScheduledAt) continue;
          if (incident.diagnosisResult) continue;

          const scheduledMs = new Date(incident.diagnosisScheduledAt).getTime();
          if (scheduledMs > cutoff) continue;

          if (incident.diagnosisDispatchedAt) {
            const dispatchedMs = new Date(incident.diagnosisDispatchedAt).getTime();
            // Lease still valid — another instance may be running diagnosis.
            if (dispatchedMs > leaseCutoff) continue;
            await storage.releaseDiagnosisDispatch(incident.incidentId);
          }

          await runIfNeeded(incident.incidentId, storage, runner);
        }
      } catch (err) {
        console.error("[diagnosis-debouncer] orphan recovery failed:", err);
      }
    })(),
  );
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
        // Check if diagnosis was already triggered (e.g. by threshold) before running.
        const incident = await storage.getIncident(incidentId);
        if (incident?.diagnosisResult) return; // Already diagnosed — skip.
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
 * If so, run diagnosis immediately.
 *
 * Called after every rebuildSnapshots to check if enough evidence has accumulated.
 *
 * @param waitUntilFn - Optional platform waitUntil (Vercel). When provided, the
 *   runIfNeeded call is wrapped so the serverless instance stays alive.
 */
export function checkGenerationThreshold(
  incidentId: string,
  generation: number,
  storage: StorageDriver,
  runner: DiagnosisRunner | undefined,
  opts: { generationThreshold: number },
  enqueueDiagnosis?: EnqueueDiagnosisFn,
  waitUntilFn?: WaitUntilFn,
): void {
  if (opts.generationThreshold > 0 && generation >= opts.generationThreshold) {
    if (enqueueDiagnosis) {
      // Guard against redundant enqueues: skip if diagnosis already in progress or complete.
      void (async () => {
        const incident = await storage.getIncident(incidentId);
        if (incident?.diagnosisResult) return;
        await storage.markDiagnosisScheduled(incidentId);
        await enqueueDiagnosis(incidentId);
      })();
    } else if (runner) {
      const runPromise = runIfNeeded(incidentId, storage, runner);
      if (waitUntilFn) {
        waitUntilFn(runPromise);
      } else {
        void runPromise;
      }
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
  if (incident.diagnosisResult) return "skipped"; // Already diagnosed — skip.

  // DB-level atomic claim: prevents cross-instance duplicate dispatch.
  const claimed = await storage.claimDiagnosisDispatch(incidentId, DEFAULT_DIAGNOSIS_LEASE_MS);
  if (!claimed) return "skipped"; // Another instance already claimed — skip.

  return runClaimedDiagnosis(incidentId, storage, runner);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
