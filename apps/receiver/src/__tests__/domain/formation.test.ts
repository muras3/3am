import { describe, it, expect } from 'vitest'
import {
  buildFormationKey,
  shouldAttachToIncident,
  getIncidentBoundTraceIds,
  normalizeDependency,
  FORMATION_WINDOW_MS,
  MAX_CROSS_SERVICE_MERGE,
} from '../../domain/formation.js'
import type { ExtractedSpan } from '../../domain/anomaly-detector.js'
import type { Incident } from '../../storage/interface.js'
import { createEmptyTelemetryScope } from '../../storage/interface.js'
import type { IncidentPacket } from '@3amoncall/core'

// Minimal IncidentPacket fixture — only fields needed for formation logic
function makePacket(
  environment: string,
  primaryService: string,
  affectedDependencies: string[] = [],
  affectedServices: string[] = [],
): IncidentPacket {
  return {
    schemaVersion: 'incident-packet/v1alpha1',
    packetId: 'pkt_test',
    incidentId: 'inc_test',
    openedAt: new Date().toISOString(),
    window: {
      start: new Date().toISOString(),
      detect: new Date().toISOString(),
      end: new Date().toISOString(),
    },
    scope: {
      environment,
      primaryService,
      affectedServices,
      affectedRoutes: [],
      affectedDependencies,
    },
    triggerSignals: [],
    evidence: {
      changedMetrics: [],
      representativeTraces: [],
      relevantLogs: [],
      platformEvents: [],
    },
    pointers: {
      traceRefs: [],
      logRefs: [],
      metricRefs: [],
      platformLogRefs: [],
    },
  }
}

function makeIncident(
  environment: string,
  primaryService: string,
  openedAt: string,
  status: 'open' | 'closed' = 'open',
  affectedDependencies: string[] = [],
  affectedServices: string[] = [],
): Incident {
  return {
    incidentId: 'inc_test',
    status,
    openedAt,
    packet: makePacket(environment, primaryService, affectedDependencies, affectedServices),
    telemetryScope: {
      ...createEmptyTelemetryScope(),
      environment,
      memberServices: [primaryService, ...affectedServices],
      dependencyServices: affectedDependencies,
    },
    spanMembership: [],
    anomalousSignals: [],
    platformEvents: [],
  }
}

const BASE_SPAN: ExtractedSpan = {
  traceId: 'trace1',
  spanId: 'span1',
  serviceName: 'api-service',
  environment: 'production',
  httpStatusCode: 500,
  spanStatusCode: 2,
  durationMs: 100,
  startTimeMs: 1700000000000,
  exceptionCount: 0,
}

// ── buildFormationKey — original tests (updated to new [spans] signature) ──────

describe('buildFormationKey', () => {
  it('returns environment matching span.environment', () => {
    const key = buildFormationKey([BASE_SPAN])
    expect(key.environment).toBe('production')
  })

  it('returns primaryService matching span.serviceName', () => {
    const key = buildFormationKey([BASE_SPAN])
    expect(key.primaryService).toBe('api-service')
  })

  it('timeWindow.start is ISO string of span.startTimeMs', () => {
    const key = buildFormationKey([BASE_SPAN])
    expect(key.timeWindow.start).toBe(new Date(BASE_SPAN.startTimeMs).toISOString())
  })

  it('timeWindow.end is ISO string of span.startTimeMs + 5 minutes', () => {
    const key = buildFormationKey([BASE_SPAN])
    expect(key.timeWindow.end).toBe(
      new Date(BASE_SPAN.startTimeMs + FORMATION_WINDOW_MS).toISOString(),
    )
  })

  // ── New: dependency derivation ──────────────────────────────────────────────

  it('dependency is set when all spans share the same peerService', () => {
    const spans: ExtractedSpan[] = [
      { ...BASE_SPAN, peerService: 'stripe' },
      { ...BASE_SPAN, spanId: 'span2', peerService: 'stripe' },
    ]
    const key = buildFormationKey(spans)
    expect(key.dependency).toBe('stripe')
  })

  it('dependency is undefined when spans have multiple distinct peerService values', () => {
    const spans: ExtractedSpan[] = [
      { ...BASE_SPAN, peerService: 'stripe' },
      { ...BASE_SPAN, spanId: 'span2', peerService: 'redis' },
    ]
    const key = buildFormationKey(spans)
    expect(key.dependency).toBeUndefined()
  })

  it('dependency is undefined when no span has peerService', () => {
    const key = buildFormationKey([BASE_SPAN])
    expect(key.dependency).toBeUndefined()
  })

  it('dependency is undefined when peerService is empty string (normalization)', () => {
    const key = buildFormationKey([{ ...BASE_SPAN, peerService: '' }])
    expect(key.dependency).toBeUndefined()
  })

  it('dependency is undefined when peerService is "localhost" (normalization)', () => {
    const key = buildFormationKey([{ ...BASE_SPAN, peerService: 'localhost' }])
    expect(key.dependency).toBeUndefined()
  })

  it('dependency is undefined when peerService is "127.0.0.1" (normalization)', () => {
    const key = buildFormationKey([{ ...BASE_SPAN, peerService: '127.0.0.1' }])
    expect(key.dependency).toBeUndefined()
  })

  it('dependency is undefined when peerService is an IP address like "192.168.1.100"', () => {
    const key = buildFormationKey([{ ...BASE_SPAN, peerService: '192.168.1.100' }])
    expect(key.dependency).toBeUndefined()
  })

  it('dependency is undefined when peerService is an internal IP address like "10.0.0.1"', () => {
    const key = buildFormationKey([{ ...BASE_SPAN, peerService: '10.0.0.1' }])
    expect(key.dependency).toBeUndefined()
  })

  it('localhost and empty peerService normalize to undefined → single-distinct → fallback (no dependency)', () => {
    // Both "localhost" and "" normalize to undefined — so normalizedDeps.size === 0 → dependency = undefined
    const spans: ExtractedSpan[] = [
      { ...BASE_SPAN, peerService: 'localhost' },
      { ...BASE_SPAN, spanId: 'span2', peerService: '' },
    ]
    const key = buildFormationKey(spans)
    expect(key.dependency).toBeUndefined()
  })
})

// ── normalizeDependency unit tests ─────────────────────────────────────────────

describe('normalizeDependency', () => {
  it('returns undefined for empty string', () => {
    expect(normalizeDependency('')).toBeUndefined()
  })

  it('returns undefined for undefined', () => {
    expect(normalizeDependency(undefined)).toBeUndefined()
  })

  it('returns undefined for "localhost"', () => {
    expect(normalizeDependency('localhost')).toBeUndefined()
  })

  it('returns undefined for "127.0.0.1"', () => {
    expect(normalizeDependency('127.0.0.1')).toBeUndefined()
  })

  it('returns undefined for "::1"', () => {
    expect(normalizeDependency('::1')).toBeUndefined()
  })

  it('returns undefined for "0.0.0.0"', () => {
    expect(normalizeDependency('0.0.0.0')).toBeUndefined()
  })

  it('returns undefined for "192.168.1.100" (IP address)', () => {
    expect(normalizeDependency('192.168.1.100')).toBeUndefined()
  })

  it('returns undefined for "10.0.0.1" (internal IP)', () => {
    expect(normalizeDependency('10.0.0.1')).toBeUndefined()
  })

  it('returns the value for a legitimate service name like "stripe"', () => {
    expect(normalizeDependency('stripe')).toBe('stripe')
  })

  it('returns the value for a FQDN-style service name', () => {
    expect(normalizeDependency('redis.internal')).toBe('redis.internal')
  })
})

// ── shouldAttachToIncident — original tests ────────────────────────────────────

describe('shouldAttachToIncident', () => {
  const openedAt = new Date(BASE_SPAN.startTimeMs).toISOString()
  // key without dependency: classic service matching
  const key = buildFormationKey([BASE_SPAN])

  it('returns true when env+service match AND signal is 4 minutes after openedAt (within 5min)', () => {
    const incident = makeIncident('production', 'api-service', openedAt)
    const signalTimeMs = BASE_SPAN.startTimeMs + 4 * 60 * 1000 // 4 min later
    expect(shouldAttachToIncident(key, incident, signalTimeMs)).toBe(true)
  })

  it('returns false when signal is 6 minutes after openedAt (outside 5min window)', () => {
    const incident = makeIncident('production', 'api-service', openedAt)
    const signalTimeMs = BASE_SPAN.startTimeMs + 6 * 60 * 1000 // 6 min later
    expect(shouldAttachToIncident(key, incident, signalTimeMs)).toBe(false)
  })

  it('returns false when incident.status === "closed"', () => {
    const incident = makeIncident('production', 'api-service', openedAt, 'closed')
    const signalTimeMs = BASE_SPAN.startTimeMs + 1 * 60 * 1000 // 1 min later
    expect(shouldAttachToIncident(key, incident, signalTimeMs)).toBe(false)
  })

  it('returns false when environment differs', () => {
    const incident = makeIncident('staging', 'api-service', openedAt)
    const signalTimeMs = BASE_SPAN.startTimeMs + 1 * 60 * 1000
    expect(shouldAttachToIncident(key, incident, signalTimeMs)).toBe(false)
  })

  it('returns false when primaryService differs (no dependency key)', () => {
    const incident = makeIncident('production', 'other-service', openedAt)
    const signalTimeMs = BASE_SPAN.startTimeMs + 1 * 60 * 1000
    expect(shouldAttachToIncident(key, incident, signalTimeMs)).toBe(false)
  })
})

// ── shouldAttachToIncident — new dependency-first tests ───────────────────────

describe('shouldAttachToIncident: dependency-first logic', () => {
  const openedAt = new Date(BASE_SPAN.startTimeMs).toISOString()
  const signalTimeMs = BASE_SPAN.startTimeMs + 1 * 60 * 1000 // 1 min later (within window)

  // ── split cases ─────────────────────────────────────────────────────────────

  it('split: same service, different dependency → false', () => {
    const key = buildFormationKey([{ ...BASE_SPAN, peerService: 'twilio' }])
    const incident = makeIncident('production', 'api-service', openedAt, 'open', ['stripe'])
    expect(shouldAttachToIncident(key, incident, signalTimeMs)).toBe(false)
  })

  it('split: same service, different dependency (closed incident) → false', () => {
    const key = buildFormationKey([{ ...BASE_SPAN, peerService: 'redis' }])
    const incident = makeIncident('production', 'api-service', openedAt, 'closed', ['stripe'])
    expect(shouldAttachToIncident(key, incident, signalTimeMs)).toBe(false)
  })

  // ── merge cases ──────────────────────────────────────────────────────────────

  it('merge: same service, same dependency → true', () => {
    const key = buildFormationKey([{ ...BASE_SPAN, peerService: 'stripe' }])
    const incident = makeIncident('production', 'api-service', openedAt, 'open', ['stripe'])
    expect(shouldAttachToIncident(key, incident, signalTimeMs)).toBe(true)
  })

  it('merge: different service (in affectedServices), same dependency → true (cross-service, small incident)', () => {
    const key = buildFormationKey([{ ...BASE_SPAN, serviceName: 'checkout-service', peerService: 'stripe' }])
    // incident has 1 affected service → length=1 < MAX_CROSS_SERVICE_MERGE(3)
    const incident = makeIncident('production', 'api-service', openedAt, 'open', ['stripe'], ['worker-service'])
    expect(shouldAttachToIncident(key, incident, signalTimeMs)).toBe(true)
  })

  it('merge: same dependency, key service is primaryService of incident → true (same service path)', () => {
    const key = buildFormationKey([{ ...BASE_SPAN, serviceName: 'api-service', peerService: 'stripe' }])
    const incident = makeIncident('production', 'api-service', openedAt, 'open', ['stripe'])
    expect(shouldAttachToIncident(key, incident, signalTimeMs)).toBe(true)
  })

  // ── MAX_CROSS_SERVICE_MERGE boundary tests ───────────────────────────────────

  it('MAX boundary: affectedServices.length === MAX-1 (=2) → true (merge allowed)', () => {
    const key = buildFormationKey([{ ...BASE_SPAN, serviceName: 'checkout-service', peerService: 'stripe' }])
    // incident already has 2 affected services: affectedServices.length = 2 = MAX-1
    const incident = makeIncident(
      'production', 'api-service', openedAt, 'open',
      ['stripe'],
      ['worker-service', 'billing-service'], // length = 2 = MAX-1
    )
    expect(shouldAttachToIncident(key, incident, signalTimeMs)).toBe(true)
  })

  it('MAX boundary: affectedServices.length === MAX (=3) → false (split)', () => {
    const key = buildFormationKey([{ ...BASE_SPAN, serviceName: 'checkout-service', peerService: 'stripe' }])
    // incident already has 3 affected services: affectedServices.length = 3 = MAX
    const incident = makeIncident(
      'production', 'api-service', openedAt, 'open',
      ['stripe'],
      ['worker-service', 'billing-service', 'report-service'], // length = 3 = MAX
    )
    expect(shouldAttachToIncident(key, incident, signalTimeMs)).toBe(false)
  })

  it('MAX boundary: affectedServices.length > MAX → false (split continues)', () => {
    const key = buildFormationKey([{ ...BASE_SPAN, serviceName: 'fifth-service', peerService: 'stripe' }])
    const incident = makeIncident(
      'production', 'api-service', openedAt, 'open',
      ['stripe'],
      ['worker-service', 'billing-service', 'report-service', 'batch-service'], // length = 4 > MAX
    )
    expect(shouldAttachToIncident(key, incident, signalTimeMs)).toBe(false)
  })

  // ── env / window negative cases ──────────────────────────────────────────────

  it('same dependency but different env → false', () => {
    const key = buildFormationKey([{ ...BASE_SPAN, peerService: 'stripe' }])
    const incident = makeIncident('staging', 'api-service', openedAt, 'open', ['stripe'])
    expect(shouldAttachToIncident(key, incident, signalTimeMs)).toBe(false)
  })

  it('same dependency but signal outside 5min window → false', () => {
    const key = buildFormationKey([{ ...BASE_SPAN, peerService: 'stripe' }])
    const incident = makeIncident('production', 'api-service', openedAt, 'open', ['stripe'])
    const outsideWindowMs = BASE_SPAN.startTimeMs + 6 * 60 * 1000 // 6 min later
    expect(shouldAttachToIncident(key, incident, outsideWindowMs)).toBe(false)
  })

  // ── fallback to classic service matching ─────────────────────────────────────

  it('fallback: no peerService → classic primaryService matching → true when same service', () => {
    const key = buildFormationKey([BASE_SPAN]) // no peerService → dependency = undefined
    const incident = makeIncident('production', 'api-service', openedAt)
    expect(shouldAttachToIncident(key, incident, signalTimeMs)).toBe(true)
  })

  it('fallback: no peerService → classic primaryService matching → false when different service', () => {
    const key = buildFormationKey([BASE_SPAN])
    const incident = makeIncident('production', 'other-service', openedAt)
    expect(shouldAttachToIncident(key, incident, signalTimeMs)).toBe(false)
  })

  it('fallback: localhost peerService → dependency=undefined → falls through to service matching', () => {
    const key = buildFormationKey([{ ...BASE_SPAN, peerService: 'localhost' }])
    expect(key.dependency).toBeUndefined() // confirm normalization
    const incident = makeIncident('production', 'api-service', openedAt)
    expect(shouldAttachToIncident(key, incident, signalTimeMs)).toBe(true)
  })

  it('fallback: IP peerService → dependency=undefined → falls through to service matching', () => {
    const key = buildFormationKey([{ ...BASE_SPAN, peerService: '192.168.0.10' }])
    expect(key.dependency).toBeUndefined()
    const incident = makeIncident('production', 'api-service', openedAt)
    expect(shouldAttachToIncident(key, incident, signalTimeMs)).toBe(true)
  })

  // ── Asymmetric case: dependency-bearing signal vs no-dependency incident ───────

  it('dependency signal does NOT merge into no-dependency incident (split-first)', () => {
    // Signal has peerService=stripe → key.dependency='stripe'
    const key = buildFormationKey([{ ...BASE_SPAN, peerService: 'stripe' }])
    // Existing incident was created without any peerService → affectedDependencies=[]
    const incident = makeIncident('production', 'api-service', openedAt, 'open', [])
    // Even though same service and same env, split because incident has no stripe dependency
    expect(shouldAttachToIncident(key, incident, signalTimeMs)).toBe(false)
  })

  // ── MAX_CROSS_SERVICE_MERGE constant sanity ──────────────────────────────────

  it('MAX_CROSS_SERVICE_MERGE equals 3', () => {
    expect(MAX_CROSS_SERVICE_MERGE).toBe(3)
  })
})

// ── getIncidentBoundTraceIds ─────────────────────────────────────────────────

describe('getIncidentBoundTraceIds', () => {
  it('returns empty set for empty spanMembership', () => {
    expect(getIncidentBoundTraceIds([]).size).toBe(0)
  })

  it('extracts traceId from "traceId:spanId" format', () => {
    const result = getIncidentBoundTraceIds(['abc123:span1', 'def456:span2'])
    expect(result).toEqual(new Set(['abc123', 'def456']))
  })

  it('deduplicates traceIds from multiple spans in the same trace', () => {
    const result = getIncidentBoundTraceIds(['trace1:span1', 'trace1:span2', 'trace2:span3'])
    expect(result).toEqual(new Set(['trace1', 'trace2']))
  })
})

// ── shouldAttachToIncident — trace-based cross-service merge (ADR 0033) ──────

describe('shouldAttachToIncident: trace-based cross-service merge (ADR 0033)', () => {
  const openedAt = new Date(BASE_SPAN.startTimeMs).toISOString()
  const signalTimeMs = BASE_SPAN.startTimeMs + 1 * 60 * 1000 // 1 min later

  it('shared trace + within window + affectedServices < MAX → true', () => {
    const key = buildFormationKey([{ ...BASE_SPAN, serviceName: 'notification-svc' }])
    const incident = makeIncident('production', 'web-service', openedAt, 'open', [], ['web-service'])
    expect(shouldAttachToIncident(key, incident, signalTimeMs, 1)).toBe(true)
  })

  it('shared trace + affectedServices >= MAX → false', () => {
    const key = buildFormationKey([{ ...BASE_SPAN, serviceName: 'fourth-svc' }])
    const incident = makeIncident('production', 'svc-a', openedAt, 'open', [], ['svc-a', 'svc-b', 'svc-c'])
    expect(shouldAttachToIncident(key, incident, signalTimeMs, 1)).toBe(false)
  })

  it('no shared traces (sharedTraceCount=0) → false', () => {
    const key = buildFormationKey([{ ...BASE_SPAN, serviceName: 'notification-svc' }])
    const incident = makeIncident('production', 'web-service', openedAt, 'open', [], ['web-service'])
    expect(shouldAttachToIncident(key, incident, signalTimeMs, 0)).toBe(false)
  })

  it('shared trace + different environment → false', () => {
    const key = buildFormationKey([{ ...BASE_SPAN, serviceName: 'notification-svc' }])
    const incident = makeIncident('staging', 'web-service', openedAt, 'open', [], ['web-service'])
    expect(shouldAttachToIncident(key, incident, signalTimeMs, 1)).toBe(false)
  })

  it('shared trace + outside time window → false', () => {
    const key = buildFormationKey([{ ...BASE_SPAN, serviceName: 'notification-svc' }])
    const incident = makeIncident('production', 'web-service', openedAt, 'open', [], ['web-service'])
    const outsideWindowMs = BASE_SPAN.startTimeMs + 6 * 60 * 1000
    expect(shouldAttachToIncident(key, incident, outsideWindowMs, 1)).toBe(false)
  })

  it('shared trace + closed incident → false', () => {
    const key = buildFormationKey([{ ...BASE_SPAN, serviceName: 'notification-svc' }])
    const incident = makeIncident('production', 'web-service', openedAt, 'closed', [], ['web-service'])
    expect(shouldAttachToIncident(key, incident, signalTimeMs, 1)).toBe(false)
  })

  it('trace fallback when service does not match (no dep) — basic ADR 0033 case', () => {
    const key = buildFormationKey([{ ...BASE_SPAN, serviceName: 'notification-svc' }])
    const incident = makeIncident('production', 'web-service', openedAt, 'open', [], ['web-service'])
    // sharedTraceCount=2 means 2 traceIds in common
    expect(shouldAttachToIncident(key, incident, signalTimeMs, 2)).toBe(true)
  })

  it('sharedTraceCount=undefined → backward compatible (no trace merge)', () => {
    const key = buildFormationKey([{ ...BASE_SPAN, serviceName: 'notification-svc' }])
    const incident = makeIncident('production', 'web-service', openedAt, 'open', [], ['web-service'])
    expect(shouldAttachToIncident(key, incident, signalTimeMs)).toBe(false)
  })

  it('dep-bearing signal + shared trace → still false (split-first not overridden)', () => {
    const key = buildFormationKey([{ ...BASE_SPAN, peerService: 'stripe' }])
    // incident has no stripe dependency
    const incident = makeIncident('production', 'api-service', openedAt, 'open', [])
    expect(shouldAttachToIncident(key, incident, signalTimeMs, 5)).toBe(false)
  })
})

// ── shouldAttachToIncident — D3: affectedServices expansion ─────────────────

describe('shouldAttachToIncident: D3 affectedServices expansion (ADR 0033)', () => {
  const openedAt = new Date(BASE_SPAN.startTimeMs).toISOString()
  const signalTimeMs = BASE_SPAN.startTimeMs + 1 * 60 * 1000

  it('no dep, primaryService in affectedServices (not == primaryService) → true', () => {
    const key = buildFormationKey([BASE_SPAN]) // primaryService: api-service, dep: undefined
    // incident primaryService is "notification-svc" but affectedServices includes "api-service"
    const incident = makeIncident('production', 'notification-svc', openedAt, 'open', [], ['notification-svc', 'api-service'])
    expect(shouldAttachToIncident(key, incident, signalTimeMs)).toBe(true)
  })

  it('no dep, primaryService in affectedServices but MAX exceeded → false', () => {
    const key = buildFormationKey([{ ...BASE_SPAN, serviceName: 'fourth-svc' }])
    const incident = makeIncident('production', 'svc-a', openedAt, 'open', [], ['svc-a', 'svc-b', 'fourth-svc'])
    // affectedServices.length === 3 === MAX, but fourth-svc IS in affectedServices
    // D3 check: affectedServices.includes('fourth-svc') → true — this is a service
    // already in the incident, so it should merge regardless of MAX
    expect(shouldAttachToIncident(key, incident, signalTimeMs)).toBe(true)
  })

  it('3 services merged + 4th via trace → MAX guard blocks', () => {
    const key = buildFormationKey([{ ...BASE_SPAN, serviceName: 'fourth-svc' }])
    // fourth-svc is NOT in affectedServices, only trace would merge it
    const incident = makeIncident('production', 'svc-a', openedAt, 'open', [], ['svc-a', 'svc-b', 'svc-c'])
    expect(shouldAttachToIncident(key, incident, signalTimeMs, 1)).toBe(false)
  })
})

// ── buildFormationKey precondition guard ──────────────────────────────────────

describe('buildFormationKey: precondition', () => {
  it('throws when called with an empty spans array', () => {
    expect(() => buildFormationKey([])).toThrow('buildFormationKey requires at least one span')
  })
})
