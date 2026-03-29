/**
 * Lazy cleanup coordinator — runs storage + telemetry cleanup at most
 * once per CLEANUP_INTERVAL_MS (5 minutes).
 *
 * Called from both ingest (traces/metrics/logs) and API (incidents) endpoints
 * so cleanup fires regardless of traffic pattern.
 *
 * Guarantees:
 * - Cleanup failure never fails the calling request (catch + log)
 * - Process-local interval gating (no cross-instance coordination)
 * - Storage (closed incidents), telemetry (spans/metrics/logs), and
 *   snapshots are all cleaned in parallel
 */
import type { StorageDriver } from "../storage/interface.js";
import type { TelemetryStoreDriver } from "../telemetry/interface.js";
import { getRetentionCutoff, CLEANUP_INTERVAL_MS } from "./config.js";

async function listAllIncidents(storage: StorageDriver) {
  const items = [];
  let cursor: string | undefined = undefined;
  do {
    const page = await storage.listIncidents({ limit: 100, cursor });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return items;
}

let lastCleanupMs = 0;

/**
 * Run cleanup if enough time has passed since the last run.
 * Safe to call on every request — returns immediately if interval not reached.
 */
export async function maybeCleanup(
  storage: StorageDriver,
  telemetryStore: TelemetryStoreDriver,
  nowMs?: number,
): Promise<void> {
  const now = nowMs ?? Date.now();
  if (now - lastCleanupMs < CLEANUP_INTERVAL_MS) return;

  // Set before running to prevent re-entry from concurrent requests
  lastCleanupMs = now;

  const cutoff = getRetentionCutoff(now);
  try {
    const incidents = await listAllIncidents(storage);
    await Promise.all(
      incidents.flatMap((incident) => {
        if (incident.status === "open" && new Date(incident.lastActivityAt).getTime() < cutoff.getTime()) {
          return [storage.updateIncidentStatus(incident.incidentId, "closed")];
        }
        return [];
      }),
    );
    await Promise.all([
      storage.deleteExpiredIncidents(cutoff),
      telemetryStore.deleteExpired(cutoff),
      telemetryStore.deleteExpiredSnapshots(cutoff),
    ]);
  } catch (err) {
    console.error("[cleanup] lazy cleanup failed:", err);
    // Never rethrow — cleanup failure must not break the request
  }
}

/** Reset the cleanup timer — exported for testing only. */
export function _resetCleanupTimerForTest(): void {
  lastCleanupMs = 0;
}
