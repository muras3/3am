import type { IncidentFormationKey } from '@3amoncall/core'
import type { ExtractedSpan } from './anomaly-detector.js'
import type { Incident } from '../storage/interface.js'

/** Formation window per ADR 0017 */
export const FORMATION_WINDOW_MS = 5 * 60 * 1000

/**
 * Build a formation key from an anomalous span.
 * The timeWindow covers the 5-minute window starting at the span's startTime.
 */
export function buildFormationKey(span: ExtractedSpan): IncidentFormationKey {
  return {
    environment: span.environment,
    primaryService: span.serviceName,
    timeWindow: {
      start: new Date(span.startTimeMs).toISOString(),
      end: new Date(span.startTimeMs + FORMATION_WINDOW_MS).toISOString(),
    },
    // NOTE: dependency matching deferred to Phase C
  }
}

/**
 * Determine if a signal should be attached to an existing open incident.
 *
 * Returns true ONLY IF ALL of:
 * 1. incident.status === "open"
 * 2. incident.packet.scope.environment === key.environment
 * 3. incident.packet.scope.primaryService === key.primaryService
 * 4. signalTimeMs - openedAt <= FORMATION_WINDOW_MS
 *
 * NOTE: dependency matching deferred to Phase C
 * NOTE: 48hr close rule deferred to Phase C (needs background job)
 */
export function shouldAttachToIncident(
  key: IncidentFormationKey,
  incident: Incident,
  signalTimeMs: number,
): boolean {
  if (incident.status !== 'open') {
    return false
  }

  const scope = incident.packet.scope
  if (scope.environment !== key.environment) {
    return false
  }

  if (scope.primaryService !== key.primaryService) {
    return false
  }

  const openedAtMs = new Date(incident.openedAt).getTime()
  if (signalTimeMs - openedAtMs > FORMATION_WINDOW_MS) {
    return false
  }

  return true
}
