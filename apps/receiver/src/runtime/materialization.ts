/**
 * On-read materialization — ensures incident snapshots are fresh before serving.
 *
 * Replaces the old pattern of rebuilding snapshots inline during metrics/logs ingest.
 * Instead, ingest only writes telemetry data + touchIncidentActivity, and the read path
 * calls ensureIncidentMaterialized() to rebuild if stale.
 *
 * Staleness: snapshot updatedAt < incident lastActivityAt.
 * Concurrency: DB-backed lease (materialization_claimed_at) prevents duplicate rebuilds.
 */

import type { StorageDriver } from "../storage/interface.js";
import type { TelemetryStoreDriver } from "../telemetry/interface.js";
import { rebuildSnapshots } from "../telemetry/snapshot-builder.js";
import type { DiagnosisRunner } from "./diagnosis-runner.js";
import { checkGenerationThreshold, type WaitUntilFn } from "./diagnosis-debouncer.js";
import type { DiagnosisConfig } from "./diagnosis-debouncer.js";
import type { EnqueueDiagnosisFn } from "./diagnosis-dispatch.js";

/**
 * Ensure an incident's evidence snapshots are up-to-date.
 *
 * Returns true if a rebuild was performed, false if snapshots were already fresh
 * or another reader is already rebuilding.
 *
 * @param waitUntilFn - Optional platform waitUntil (Vercel). When provided,
 *   generation-threshold diagnosis runs are wrapped so the serverless instance
 *   stays alive until diagnosis completes.
 */
export async function ensureIncidentMaterialized(
  incidentId: string,
  storage: StorageDriver,
  telemetryStore: TelemetryStoreDriver,
  diagnosisConfig?: DiagnosisConfig,
  diagnosisRunner?: DiagnosisRunner,
  enqueueDiagnosis?: EnqueueDiagnosisFn,
  waitUntilFn?: WaitUntilFn,
): Promise<boolean> {
  const incident = await storage.getIncident(incidentId);
  if (!incident) return false;

  // Check freshness: compare latest snapshot updatedAt with incident lastActivityAt
  const snapshots = await telemetryStore.getSnapshots(incidentId);
  if (snapshots.length > 0) {
    const latestSnapshotAt = Math.max(
      ...snapshots.map((s) => new Date(s.updatedAt).getTime()),
    );
    const activityAt = new Date(incident.lastActivityAt).getTime();
    if (latestSnapshotAt > activityAt) {
      // Snapshots are strictly newer than last activity — no rebuild needed
      return false;
    }
  }

  // Snapshots are stale or missing — try to claim rebuild lease
  const claimed = await storage.claimMaterializationLease(incidentId);
  if (!claimed) {
    // Another reader is already rebuilding — skip
    return false;
  }

  try {
    await rebuildSnapshots(incidentId, telemetryStore, storage);

    // Trigger diagnosis threshold check after successful rebuild
    if (diagnosisConfig && diagnosisConfig.generationThreshold > 0) {
      const updated = await storage.getIncident(incidentId);
      if (updated) {
        checkGenerationThreshold(
          incidentId,
          updated.packet.generation ?? 1,
          storage,
          diagnosisRunner,
          { generationThreshold: diagnosisConfig.generationThreshold },
          enqueueDiagnosis,
          waitUntilFn,
        );
      }
    }

    return true;
  } catch (err) {
    // Graceful degradation: rebuild failure should not block the read path.
    // The caller serves stale (or empty) data instead of returning 500.
    console.error(`[materialization] rebuildSnapshots failed for ${incidentId}:`, err);
    return false;
  } finally {
    await storage.releaseMaterializationLease(incidentId);
  }
}
