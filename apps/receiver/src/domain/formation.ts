import type { IncidentFormationKey } from '@3am/core'
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
 * Loopback / zero hostnames that are NOT meaningful peer.service / server.address identifiers.
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
 * Normalise a raw dependency identifier value.
 *
 * Input may originate from either:
 *   - `peer.service` — deprecated OTel semconv; carries a logical service name (e.g. "stripe").
 *     Preferred by old SDK versions and set explicitly by users for human-readable incident labels.
 *   - `server.address` — stable OTel semconv; carries a hostname (e.g. "api.stripe.com").
 *     Emitted by new SDK versions when peer.service is absent.
 *
 * Returns `undefined` for values that carry no meaningful dependency identity:
 *   - empty / undefined
 *   - loopback hostnames (IGNORED_DEPENDENCY_NAMES)
 *   - bare IPv4 addresses (IaaS-internal endpoints)
 */
export function normalizeDependency(raw: string | undefined): string | undefined {
  if (!raw || raw.trim() === '') return undefined
  if (IGNORED_DEPENDENCY_NAMES.has(raw.toLowerCase())) return undefined
  if (IP_ADDRESS_PATTERN.test(raw)) return undefined
  return raw.toLowerCase()
}

/**
 * Build a formation key from the full set of anomalous spans in a batch.
 *
 * `dependency` is derived only when ALL anomalous spans agree on the same
 * peer.service / server.address value (after normalization).  Multiple distinct values
 * → dependency = undefined (safe default that falls back to service matching).
 *
 * Spans should be pre-sorted by (startTimeMs asc, serviceName asc) so that
 * `primaryService` is stable across requests (matches Plan 3 selectPrimaryService).
 */
export function buildFormationKey(spans: ExtractedSpan[]): IncidentFormationKey {
  if (spans.length === 0) throw new Error('buildFormationKey requires at least one span')
  const firstSpan = spans[0]!


  // Collect raw peer.service / server.address values, ignoring absent ones
  const rawPeerServices = spans
    .map((s) => s.peerService)
    .filter((p): p is string => p !== undefined)

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
 * Extract unique traceIds from an incident's spanMembership set.
 * Each entry has format "traceId:spanId" — we extract the traceId portion.
 * Used for trace-based cross-service merge (ADR 0033).
 */
export function getIncidentBoundTraceIds(spanMembership: string[]): Set<string> {
  const traceIds = new Set<string>()
  for (const ref of spanMembership) {
    const colonIdx = ref.indexOf(':')
    if (colonIdx > 0) traceIds.add(ref.substring(0, colonIdx))
  }
  return traceIds
}

/**
 * Determine if a signal should be attached to an existing open incident.
 *
 * Priority order (ADR 0017 + ADR 0033):
 *
 *   1. dependency match + same/cross service (ADR 0017)
 *   2. same primaryService, no dependency (ADR 0017)
 *   3. service already in affectedServices, no dependency (ADR 0033 D3)
 *   4. shared traceId cross-service merge (ADR 0033)
 *   5. no match → new incident
 *
 * When a `dependency` is present, split-first applies (ADR 0017):
 *   dep NOT in incident → always split. Trace match does NOT override split-first.
 *
 * NOTE: 48hr close rule deferred to Phase C (needs background job)
 */
export function shouldAttachToIncident(
  key: IncidentFormationKey,
  incident: Incident,
  signalTimeMs: number,
  sharedTraceCount?: number,
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
    // dependency-first: split when the incident does not share the same dependency.
    // Trace match does NOT override split-first (ADR 0033 D2).
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

  // no dependency info → service matching + trace-based fallback
  if (scope.primaryService === key.primaryService) return true

  // ADR 0033 D3: service already pulled into incident (e.g. via prior trace merge)
  if (scope.affectedServices.includes(key.primaryService)) return true

  // ADR 0033: trace-based cross-service merge — shared traceId with anomalous spans
  if (sharedTraceCount !== undefined && sharedTraceCount > 0
    && scope.affectedServices.length < MAX_CROSS_SERVICE_MERGE) {
    return true
  }

  return false
}
