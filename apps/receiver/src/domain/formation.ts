import type { IncidentFormationKey } from '@3amoncall/core'
import type { ExtractedSpan } from './anomaly-detector.js'
import type { Incident } from '../storage/interface.js'

/** Formation window per ADR 0017 */
export const FORMATION_WINDOW_MS = 5 * 60 * 1000

/**
 * Maximum number of distinct services that may be merged into a single incident
 * when they share the same external dependency (ADR 0017).
 *
 * Chosen conservatively based on the reference scenario
 * `third_party_api_rate_limit_cascade` where 2 services call Stripe — MAX=3
 * keeps them together while blocking a hypothetical 4th service pull-in.
 * NOTE: This is a provisional value; revisit with production data.
 */
export const MAX_CROSS_SERVICE_MERGE = 3

/**
 * Loopback / zero hostnames that are NOT meaningful peer.service identifiers.
 * IaaS-internal IP addresses are handled separately via IP_ADDRESS_PATTERN.
 */
const IGNORED_DEPENDENCY_NAMES = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
])

/** Matches bare IPv4 addresses (e.g. "10.0.0.1", "192.168.1.100"). */
const IP_ADDRESS_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/

/**
 * Normalise a raw peer.service value.
 * Returns `undefined` for values that carry no meaningful dependency identity:
 *   - empty / undefined
 *   - loopback hostnames (IGNORED_DEPENDENCY_NAMES)
 *   - bare IPv4 addresses (IaaS-internal endpoints)
 */
export function normalizeDependency(raw: string | undefined): string | undefined {
  if (!raw || raw.trim() === '') return undefined
  if (IGNORED_DEPENDENCY_NAMES.has(raw.toLowerCase())) return undefined
  if (IP_ADDRESS_PATTERN.test(raw)) return undefined
  return raw
}

/**
 * Build a formation key from the full set of anomalous spans in a batch.
 *
 * `dependency` is derived only when ALL anomalous spans agree on the same
 * peer.service (after normalization).  Multiple distinct peer.service values
 * → dependency = undefined (safe default that falls back to service matching).
 *
 * Spans should be pre-sorted by (startTimeMs asc, serviceName asc) so that
 * `primaryService` is stable across requests (matches Plan 3 selectPrimaryService).
 */
export function buildFormationKey(spans: ExtractedSpan[]): IncidentFormationKey {
  const firstSpan = spans[0]

  // Collect raw peer.service values, ignoring absent ones
  const rawPeerServices = spans
    .map((s) => s.peerService)
    .filter((p): p is string => p !== undefined && p !== '')

  // Normalize each raw value; after normalization collapse distinct set
  const normalizedDeps = new Set(
    rawPeerServices.map(normalizeDependency).filter((d): d is string => d !== undefined),
  )

  // Use dependency only when exactly one normalized value appears across all spans
  const dependency = normalizedDeps.size === 1 ? [...normalizedDeps][0] : undefined

  return {
    environment: firstSpan.environment,
    primaryService: firstSpan.serviceName,
    dependency,
    timeWindow: {
      start: new Date(firstSpan.startTimeMs).toISOString(),
      end: new Date(firstSpan.startTimeMs + FORMATION_WINDOW_MS).toISOString(),
    },
  }
}

/**
 * Determine if a signal should be attached to an existing open incident.
 *
 * When a `dependency` is present in the formation key, dependency-first
 * split/merge logic applies (ADR 0017):
 *
 *   - dependency NOT in scope.affectedDependencies → always split (different dep)
 *   - same service + same dependency → merge
 *   - different service + same dependency → merge only if affectedServices < MAX_CROSS_SERVICE_MERGE
 *
 * When there is no dependency, classic primaryService + environment matching
 * applies (unchanged from the original implementation).
 *
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

  const openedAtMs = new Date(incident.openedAt).getTime()
  if (signalTimeMs - openedAtMs > FORMATION_WINDOW_MS) {
    return false
  }

  if (key.dependency !== undefined) {
    // dependency-first: split when the incident does not share the same dependency
    if (!scope.affectedDependencies.includes(key.dependency)) {
      return false // different dependency → always split
    }

    // same dependency found in incident scope
    const sameService =
      scope.primaryService === key.primaryService ||
      scope.affectedServices.includes(key.primaryService)

    if (sameService) return true

    // cross-service + same dependency: only merge within the conservative guard.
    // NOTE: scope.affectedServices always includes primaryService (packetizer contract),
    // so for a fresh single-service incident affectedServices.length === 1.
    // The guard therefore allows at most MAX_CROSS_SERVICE_MERGE − 1 additional services,
    // yielding a total of MAX_CROSS_SERVICE_MERGE distinct services per incident.
    return scope.affectedServices.length < MAX_CROSS_SERVICE_MERGE
  }

  // no dependency info → classic service matching
  return scope.primaryService === key.primaryService
}
