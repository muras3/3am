import { describe, it, expect, vi } from 'vitest'
import {
  buildRuntimeMap,
  normalizeRoute,
  normalizeSpanName,
  normalizePeerService,
} from '../../ambient/runtime-map.js'
import type { TelemetrySpan, TelemetryStoreDriver } from '../../telemetry/interface.js'
import type { StorageDriver, Incident } from '../../storage/interface.js'
import type { IncidentPacket } from '@3am/core'

// ── Helpers ────────────────────────────────────────────────────────────────

function makeSpan(overrides: Partial<TelemetrySpan> = {}): TelemetrySpan {
  return {
    traceId: 'trace-1',
    spanId: 'span-1',
    serviceName: 'api',
    environment: 'production',
    spanName: 'GET /users',
    spanStatusCode: 1,
    durationMs: 100,
    startTimeMs: Date.now() - 60_000,
    exceptionCount: 0,
    attributes: {},
    ingestedAt: Date.now(),
    ...overrides,
  }
}

function makeMockTelemetryStore(spans: TelemetrySpan[] = []): TelemetryStoreDriver {
  return {
    ingestSpans: vi.fn(),
    ingestMetrics: vi.fn(),
    ingestLogs: vi.fn(),
    querySpans: vi.fn().mockResolvedValue(spans),
    queryMetrics: vi.fn().mockResolvedValue([]),
    queryLogs: vi.fn().mockResolvedValue([]),
    upsertSnapshot: vi.fn(),
    getSnapshots: vi.fn().mockResolvedValue([]),
    deleteSnapshots: vi.fn(),
    deleteExpired: vi.fn(),
    deleteExpiredSnapshots: vi.fn(),
  }
}

function makeMockStorage(incidents: Incident[] = []): StorageDriver {
  return {
    nextIncidentSequence: vi.fn().mockResolvedValue(1),
    createIncident: vi.fn(),
    updatePacket: vi.fn(),
    updateIncidentStatus: vi.fn(),
    touchIncidentActivity: vi.fn(),
    appendDiagnosis: vi.fn(),
    listIncidents: vi.fn().mockResolvedValue({ items: incidents }),
    getIncident: vi.fn(),
    getIncidentByPacketId: vi.fn(),
    deleteExpiredIncidents: vi.fn(),
    expandTelemetryScope: vi.fn(),
    appendSpanMembership: vi.fn(),
    appendAnomalousSignals: vi.fn(),
    appendPlatformEvents: vi.fn(),
    claimDiagnosisDispatch: vi.fn(),
    releaseDiagnosisDispatch: vi.fn(),
    markDiagnosisScheduled: vi.fn(),
    clearDiagnosisScheduled: vi.fn(),
    saveThinEvent: vi.fn(),
    listThinEvents: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn(),
    setSettings: vi.fn(),
    appendConsoleNarrative: vi.fn(),
  }
}

function makeIncident(overrides: Partial<Incident> = {}): Incident {
  const defaultPacket: IncidentPacket = {
    schemaVersion: 'incident-packet/v1alpha1',
    packetId: 'pkt-1',
    incidentId: 'inc-1',
    openedAt: new Date().toISOString(),
    window: {
      start: new Date(Date.now() - 300_000).toISOString(),
      detect: new Date(Date.now() - 200_000).toISOString(),
      end: new Date().toISOString(),
    },
    scope: {
      environment: 'production',
      primaryService: 'api',
      affectedServices: ['api'],
      affectedRoutes: ['/users'],
      affectedDependencies: ['stripe'],
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

  return {
    incidentId: 'inc-1',
    status: 'open',
    openedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    packet: defaultPacket,
    telemetryScope: {
      windowStartMs: Date.now() - 300_000,
      windowEndMs: Date.now(),
      detectTimeMs: Date.now() - 200_000,
      environment: 'production',
      memberServices: ['api'],
      dependencyServices: ['stripe'],
    },
    spanMembership: [],
    anomalousSignals: [],
    platformEvents: [],
    ...overrides,
  }
}

// ── normalizeRoute tests ───────────────────────────────────────────────────

describe('normalizeRoute', () => {
  it('replaces numeric path segments with :id', () => {
    expect(normalizeRoute('GET', '/users/123')).toBe('/users/:id')
  })

  it('replaces UUID-like path segments with :id', () => {
    expect(normalizeRoute('GET', '/orders/abc12345-def6-7890-abcd-ef1234567890')).toBe('/orders/:id')
  })

  it('replaces short hex segments (8+ chars) with :id', () => {
    expect(normalizeRoute('GET', '/items/abcdef12')).toBe('/items/:id')
  })

  it('removes trailing slash', () => {
    expect(normalizeRoute('GET', '/users/')).toBe('/users')
  })

  it('preserves root path', () => {
    expect(normalizeRoute('GET', '/')).toBe('/')
  })

  it('lowercases the route', () => {
    expect(normalizeRoute('GET', '/Users/Profile')).toBe('/users/profile')
  })

  it('handles multiple ID segments', () => {
    expect(normalizeRoute('GET', '/users/123/orders/456')).toBe('/users/:id/orders/:id')
  })
})

// ── normalizeSpanName tests ────────────────────────────────────────────────

describe('normalizeSpanName', () => {
  it('removes HTTP method prefix', () => {
    expect(normalizeSpanName('GET /foo')).toBe('/foo')
  })

  it('replaces UUID segments with :id', () => {
    expect(normalizeSpanName('query /items/abcdef12')).toBe('query /items/:id')
  })

  it('lowercases the result', () => {
    expect(normalizeSpanName('POST /Users')).toBe('/users')
  })

  it('handles span names without method prefix', () => {
    expect(normalizeSpanName('db.query')).toBe('db.query')
  })

  it('replaces numeric segments with :id', () => {
    expect(normalizeSpanName('GET /orders/99')).toBe('/orders/:id')
  })
})

// ── normalizePeerService tests ─────────────────────────────────────────────

describe('normalizePeerService', () => {
  it('returns undefined for undefined input', () => {
    expect(normalizePeerService(undefined)).toBeUndefined()
  })

  it('returns undefined for empty string', () => {
    expect(normalizePeerService('')).toBeUndefined()
  })

  it('returns undefined for localhost', () => {
    expect(normalizePeerService('localhost')).toBeUndefined()
  })

  it('returns undefined for loopback IP', () => {
    expect(normalizePeerService('127.0.0.1')).toBeUndefined()
  })

  it('returns undefined for bare IPv4 address', () => {
    expect(normalizePeerService('10.0.0.1')).toBeUndefined()
  })

  it('returns lowercase for valid peer service', () => {
    expect(normalizePeerService('Stripe')).toBe('stripe')
  })
})

// ── buildRuntimeMap tests ──────────────────────────────────────────────────

describe('buildRuntimeMap', () => {
  it('returns empty runtime map for empty spans', async () => {
    const store = makeMockTelemetryStore([])
    const storage = makeMockStorage()

    const result = await buildRuntimeMap(store, storage)

    expect(result.state.diagnosis).toBe('ready')
    expect(result.state.source).toBe('no_telemetry')
    expect(result.services).toEqual([])
    expect(result.dependencies).toEqual([])
    expect(result.edges).toEqual([])
    expect(result.summary.activeIncidents).toBe(0)
    expect(result.summary.degradedServices).toBe(0)
  })

  it('prefers console narrative headline for incident labels', async () => {
    const store = makeMockTelemetryStore([])
    const storage = makeMockStorage([
      makeIncident({
        diagnosisResult: {
          summary: {
            what_happened: 'Long diagnosis summary that should not be the strip title',
            root_cause_hypothesis: 'rate limit',
          },
        } as Incident['diagnosisResult'],
        consoleNarrative: {
          headline: 'CDN 503 cascade on /products. Origin recovered after cache purge.',
        } as Incident['consoleNarrative'],
      }),
    ])

    const result = await buildRuntimeMap(store, storage)

    expect(result.incidents[0]?.label).toBe('CDN 503 cascade on /products. Origin recovered after cache purge.')
  })

  it('reconstructs incident-scoped fallback when live window is empty but incident spans were preserved', async () => {
    const preservedSpan = makeSpan({
      traceId: 'trace-fallback',
      spanId: 'span-fallback',
      spanKind: 2,
      httpRoute: '/checkout',
      httpMethod: 'POST',
      serviceName: 'api',
      startTimeMs: Date.now() - 3_600_000,
    })
    const store = makeMockTelemetryStore([])
    vi.mocked(store.querySpans).mockImplementation(async (filter) =>
      [preservedSpan].filter((span) =>
        span.startTimeMs >= filter.startMs && span.startTimeMs <= filter.endMs,
      ),
    )
    const storage = makeMockStorage([
      makeIncident({
        incidentId: 'inc-fallback',
        spanMembership: ['trace-fallback:span-fallback'],
        telemetryScope: {
          windowStartMs: preservedSpan.startTimeMs - 5_000,
          windowEndMs: preservedSpan.startTimeMs + 5_000,
          detectTimeMs: preservedSpan.startTimeMs,
          environment: 'production',
          memberServices: ['api'],
          dependencyServices: [],
        },
      }),
    ])

    const result = await buildRuntimeMap(store, storage)

    expect(result.state.source).toBe('incident_scope')
    expect(result.state.scopeIncidentId).toBe('inc-fallback')
    // Should produce 1 service with 1 route containing /checkout
    expect(result.services).toHaveLength(1)
    expect(result.services[0]!.routes[0]!.id).toContain('/checkout')
    expect(result.summary.activeIncidents).toBe(1)
  })

  it('projects open incidents into services when no spans are available', async () => {
    const store = makeMockTelemetryStore([])
    const storage = makeMockStorage([
      makeIncident({
        incidentId: 'inc-projected',
        packet: {
          ...makeIncident().packet,
          incidentId: 'inc-projected',
          scope: {
            ...makeIncident().packet.scope,
            primaryService: 'edge-worker',
            affectedServices: ['edge-worker', 'checkout-api'],
            affectedRoutes: ['/checkout'],
            affectedDependencies: ['stripe'],
          },
          signalSeverity: 'critical',
        },
      }),
    ])

    const result = await buildRuntimeMap(store, storage)

    expect(result.state.source).toBe('no_telemetry')
    expect(result.services.map((service) => service.serviceName)).toEqual(['checkout-api', 'edge-worker'])
    expect(result.services.find((service) => service.serviceName === 'edge-worker')?.routes).toEqual([
      expect.objectContaining({ label: '/checkout', incidentId: 'inc-projected', status: 'critical' }),
    ])
    expect(result.dependencies).toEqual([
      expect.objectContaining({ name: 'stripe', incidentId: 'inc-projected', status: 'critical' }),
    ])
    expect(result.edges).toEqual([
      expect.objectContaining({ fromService: 'edge-worker', toDependency: 'stripe', status: 'critical' }),
    ])
  })

  it('creates entry_point route inside a service from SERVER span with httpRoute', async () => {
    const span = makeSpan({
      spanId: 's1',
      spanKind: 2, // SERVER
      httpRoute: '/users',
      httpMethod: 'GET',
      serviceName: 'api',
    })
    const store = makeMockTelemetryStore([span])
    const storage = makeMockStorage()

    const result = await buildRuntimeMap(store, storage)

    expect(result.services).toHaveLength(1)
    expect(result.services[0]!.serviceName).toBe('api')
    expect(result.services[0]!.routes).toHaveLength(1)
    expect(result.services[0]!.routes[0]!.id).toBe('route:api:GET:/users')
    expect(result.services[0]!.routes[0]!.label).toBe('GET /users')
    expect(result.dependencies).toEqual([])
    expect(result.edges).toEqual([])
  })

  it('creates dependency from CLIENT span with peerService and a service→dep edge', async () => {
    const span = makeSpan({
      spanId: 's1',
      spanKind: 3, // CLIENT
      peerService: 'stripe',
      spanName: 'stripe.charges.create',
      serviceName: 'api',
    })
    const store = makeMockTelemetryStore([span])
    const storage = makeMockStorage()

    const result = await buildRuntimeMap(store, storage)

    // runtime_unit contributes to service metrics but is not a separate element
    expect(result.services).toHaveLength(1)
    expect(result.services[0]!.serviceName).toBe('api')
    // No routes (no SERVER spans)
    expect(result.services[0]!.routes).toHaveLength(0)

    // One dependency
    expect(result.dependencies).toHaveLength(1)
    expect(result.dependencies[0]!.id).toBe('dep:stripe')
    expect(result.dependencies[0]!.name).toBe('stripe')

    // One service→dep edge
    expect(result.edges).toHaveLength(1)
    expect(result.edges[0]!.fromService).toBe('api')
    expect(result.edges[0]!.toDependency).toBe('stripe')
  })

  it('groups two entry_point spans with same serviceName into 1 service with 2 routes', async () => {
    const spans: TelemetrySpan[] = [
      makeSpan({
        spanId: 's1',
        spanKind: 2,
        httpRoute: '/users',
        httpMethod: 'GET',
        serviceName: 'api',
      }),
      makeSpan({
        spanId: 's2',
        spanKind: 2,
        httpRoute: '/orders',
        httpMethod: 'GET',
        serviceName: 'api',
      }),
    ]
    const store = makeMockTelemetryStore(spans)
    const storage = makeMockStorage()

    const result = await buildRuntimeMap(store, storage)

    expect(result.services).toHaveLength(1)
    expect(result.services[0]!.serviceName).toBe('api')
    expect(result.services[0]!.routes).toHaveLength(2)
    const routeIds = result.services[0]!.routes.map((r) => r.id)
    expect(routeIds).toContain('route:api:GET:/users')
    expect(routeIds).toContain('route:api:GET:/orders')
  })

  it('runtime_unit nodes contribute to service metrics but are not in response', async () => {
    const spans: TelemetrySpan[] = [
      makeSpan({
        spanId: 'server',
        spanKind: 2,
        httpRoute: '/checkout',
        httpMethod: 'POST',
        serviceName: 'api',
        durationMs: 100,
        httpStatusCode: 200,
      }),
      makeSpan({
        spanId: 'internal',
        spanKind: 1,
        spanName: 'db.query',
        serviceName: 'api',
        durationMs: 50,
        httpStatusCode: 500, // error on internal span
      }),
    ]
    const store = makeMockTelemetryStore(spans)
    const storage = makeMockStorage()

    const result = await buildRuntimeMap(store, storage)

    // Only 1 service, no separate runtime_unit entries
    expect(result.services).toHaveLength(1)
    // The service errorRate should include the internal span error
    const svc = result.services[0]!
    expect(svc.metrics.errorRate).toBeGreaterThan(0)
    // No standalone runtime_unit in dependencies
    expect(result.dependencies).toHaveLength(0)
  })

  it('service status is worst child route status (critical > degraded > healthy)', async () => {
    // Route A: healthy (0 errors)
    // Route B: critical (50% errors)
    const spans: TelemetrySpan[] = [
      makeSpan({ spanId: 'a', spanKind: 2, httpRoute: '/health', httpMethod: 'GET', httpStatusCode: 200, serviceName: 'api' }),
      makeSpan({ spanId: 'b1', spanKind: 2, httpRoute: '/charge', httpMethod: 'POST', httpStatusCode: 200, serviceName: 'api' }),
      makeSpan({ spanId: 'b2', spanKind: 2, httpRoute: '/charge', httpMethod: 'POST', httpStatusCode: 500, serviceName: 'api' }),
    ]
    const store = makeMockTelemetryStore(spans)
    const storage = makeMockStorage()

    const result = await buildRuntimeMap(store, storage)

    expect(result.services).toHaveLength(1)
    expect(result.services[0]!.status).toBe('critical')
  })

  it('collapses multiple spans with same route into 1 route with aggregated metrics', async () => {
    const spans = Array.from({ length: 10 }, (_, i) =>
      makeSpan({
        spanId: `s-${i}`,
        spanKind: 2, // SERVER
        httpRoute: '/users',
        httpMethod: 'GET',
        serviceName: 'api',
        durationMs: (i + 1) * 10, // 10, 20, ..., 100
        httpStatusCode: i === 9 ? 500 : 200, // 1 error out of 10
      }),
    )
    const store = makeMockTelemetryStore(spans)
    const storage = makeMockStorage()

    const result = await buildRuntimeMap(store, storage)

    expect(result.services).toHaveLength(1)
    const route = result.services[0]!.routes[0]!
    expect(route.errorRate).toBeCloseTo(0.1, 5) // 1/10
    expect(result.services[0]!.metrics.p95Ms).toBe(100) // p95 of [10..100]
    expect(result.services[0]!.metrics.reqPerSec).toBeGreaterThan(0)
  })

  it('sets route status to critical when errorRate >= 0.05', async () => {
    // 19 OK + 1 error = 5% error rate
    const spans: TelemetrySpan[] = []
    for (let i = 0; i < 19; i++) {
      spans.push(makeSpan({
        spanId: `ok-${i}`,
        spanKind: 2,
        httpRoute: '/users',
        httpMethod: 'GET',
        httpStatusCode: 200,
      }))
    }
    spans.push(makeSpan({
      spanId: 'err-0',
      spanKind: 2,
      httpRoute: '/users',
      httpMethod: 'GET',
      httpStatusCode: 500,
    }))

    const store = makeMockTelemetryStore(spans)
    const storage = makeMockStorage()

    const result = await buildRuntimeMap(store, storage)
    const route = result.services[0]!.routes[0]!
    expect(route.status).toBe('critical')
    expect(route.errorRate).toBeCloseTo(0.05, 5)
  })

  it('sets route status to degraded when errorRate >= 0.01 but < 0.05', async () => {
    // 99 OK + 1 error = 1% error rate
    const spans: TelemetrySpan[] = []
    for (let i = 0; i < 99; i++) {
      spans.push(makeSpan({
        spanId: `ok-${i}`,
        spanKind: 2,
        httpRoute: '/users',
        httpMethod: 'GET',
        httpStatusCode: 200,
      }))
    }
    spans.push(makeSpan({
      spanId: 'err-0',
      spanKind: 2,
      httpRoute: '/users',
      httpMethod: 'GET',
      httpStatusCode: 500,
    }))

    const store = makeMockTelemetryStore(spans)
    const storage = makeMockStorage()

    const result = await buildRuntimeMap(store, storage)
    const route = result.services[0]!.routes[0]!
    expect(route.status).toBe('degraded')
  })

  it('deduplicates service→dep edges with same fromService/toDependency', async () => {
    // Two CLIENT spans to the same dependency — should produce 1 merged service edge
    const spans: TelemetrySpan[] = [
      makeSpan({
        spanId: 's1',
        spanKind: 3, // CLIENT
        peerService: 'stripe',
        spanName: 'stripe.charges.create',
        serviceName: 'api',
      }),
      makeSpan({
        spanId: 's2',
        spanKind: 3, // CLIENT
        peerService: 'stripe',
        spanName: 'stripe.charges.create',
        serviceName: 'api',
      }),
    ]

    const store = makeMockTelemetryStore(spans)
    const storage = makeMockStorage()

    const result = await buildRuntimeMap(store, storage)

    // 1 service, 1 dep
    expect(result.services).toHaveLength(1)
    expect(result.dependencies).toHaveLength(1)
    // 1 merged service edge
    expect(result.edges).toHaveLength(1)
    expect(result.edges[0]!.fromService).toBe('api')
    expect(result.edges[0]!.toDependency).toBe('stripe')
  })

  it('excludes self-loop edges', async () => {
    // Parent and child spans that resolve to the same node
    const spans: TelemetrySpan[] = [
      makeSpan({
        spanId: 'parent',
        spanKind: 2, // SERVER
        httpRoute: '/users',
        httpMethod: 'GET',
        serviceName: 'api',
      }),
      makeSpan({
        spanId: 'child',
        parentSpanId: 'parent',
        spanKind: 2, // SERVER
        httpRoute: '/users',
        httpMethod: 'GET',
        serviceName: 'api',
      }),
    ]

    const store = makeMockTelemetryStore(spans)
    const storage = makeMockStorage()

    const result = await buildRuntimeMap(store, storage)

    // Both spans map to the same route — no dep edge created
    expect(result.services).toHaveLength(1)
    expect(result.services[0]!.routes).toHaveLength(1)
    expect(result.edges).toHaveLength(0)
  })

  it('builds parent-child spans correctly (no extra dep edges for internal spans)', async () => {
    const spans: TelemetrySpan[] = [
      makeSpan({
        spanId: 'parent',
        spanKind: 2, // SERVER
        httpRoute: '/checkout',
        httpMethod: 'POST',
        serviceName: 'api',
      }),
      makeSpan({
        spanId: 'child',
        parentSpanId: 'parent',
        spanKind: 1, // INTERNAL
        spanName: 'process-payment',
        serviceName: 'api',
      }),
    ]

    const store = makeMockTelemetryStore(spans)
    const storage = makeMockStorage()

    const result = await buildRuntimeMap(store, storage)

    // 1 service (api) with 1 route; internal span contributes to service but no dep edge
    expect(result.services).toHaveLength(1)
    expect(result.services[0]!.routes).toHaveLength(1)
    expect(result.services[0]!.routes[0]!.id).toBe('route:api:POST:/checkout')
    expect(result.dependencies).toHaveLength(0)
    expect(result.edges).toHaveLength(0)
  })

  it('calculates summary correctly', async () => {
    // 1 healthy service (/health) + 1 degraded service route (/orders)
    const spans: TelemetrySpan[] = []

    // Healthy route: 50 spans with 200
    for (let i = 0; i < 50; i++) {
      spans.push(makeSpan({
        spanId: `healthy-${i}`,
        spanKind: 2,
        httpRoute: '/health',
        httpMethod: 'GET',
        httpStatusCode: 200,
        durationMs: 50,
      }))
    }

    // Degraded route: 50 spans with 2% error rate
    for (let i = 0; i < 49; i++) {
      spans.push(makeSpan({
        spanId: `deg-ok-${i}`,
        spanKind: 2,
        httpRoute: '/orders',
        httpMethod: 'GET',
        httpStatusCode: 200,
        durationMs: 50,
      }))
    }
    spans.push(makeSpan({
      spanId: 'deg-err-0',
      spanKind: 2,
      httpRoute: '/orders',
      httpMethod: 'GET',
      httpStatusCode: 500,
      durationMs: 50,
    }))

    // Also add 1 internal span — contributes to service metrics but not to summary service count
    spans.push(makeSpan({
      spanId: 'internal-1',
      spanKind: 1,
      spanName: 'db.query',
      serviceName: 'api',
    }))

    const store = makeMockTelemetryStore(spans)
    const storage = makeMockStorage()

    const result = await buildRuntimeMap(store, storage)

    // 1 service with status degraded (worst route = degraded /orders)
    expect(result.summary.degradedServices).toBe(1)
    expect(result.summary.clusterReqPerSec).toBeGreaterThan(0)
    expect(result.summary.clusterP95Ms).toBe(50)
    expect(result.state.diagnosis).toBe('ready')
  })

  it('keeps diagnosis state ready when few nodes', async () => {
    const span = makeSpan({
      spanId: 's1',
      spanKind: 2,
      httpRoute: '/users',
      httpMethod: 'GET',
    })
    const store = makeMockTelemetryStore([span])
    const storage = makeMockStorage()

    const result = await buildRuntimeMap(store, storage)

    expect(result.state.diagnosis).toBe('ready')
  })

  it('assigns incidentId to matching services, routes, and dependencies when open incident exists', async () => {
    const spans: TelemetrySpan[] = [
      makeSpan({
        spanId: 's1',
        spanKind: 2,
        httpRoute: '/users',
        httpMethod: 'GET',
        serviceName: 'api',
      }),
      makeSpan({
        spanId: 's2',
        spanKind: 3,
        peerService: 'stripe',
        spanName: 'stripe.call',
        serviceName: 'api',
      }),
    ]

    const incident = makeIncident()
    const store = makeMockTelemetryStore(spans)
    const storage = makeMockStorage([incident])

    const result = await buildRuntimeMap(store, storage)

    // service should be matched by primaryService "api"
    const svc = result.services.find((s) => s.serviceName === 'api')!
    expect(svc.incidentId).toBe('inc-1')

    // route should be matched by affectedRoutes "/users"
    const route = svc.routes.find((r) => r.id.includes('/users'))!
    expect(route.incidentId).toBe('inc-1')

    // dependency node should be matched by affectedDependencies "stripe"
    const dep = result.dependencies.find((d) => d.id === 'dep:stripe')!
    expect(dep.incidentId).toBe('inc-1')

    // incidents list should have the open incident
    expect(result.incidents.length).toBe(1)
    expect(result.incidents[0]!.incidentId).toBe('inc-1')
  })

  it('does not assign closed incidents to services or dependencies', async () => {
    const spans = [makeSpan({
      spanId: 's1',
      spanKind: 2,
      httpRoute: '/users',
      httpMethod: 'GET',
      serviceName: 'api',
    })]

    const incident = makeIncident({ status: 'closed' })
    const store = makeMockTelemetryStore(spans)
    const storage = makeMockStorage([incident])

    const result = await buildRuntimeMap(store, storage)

    const svc = result.services[0]!
    expect(svc.incidentId).toBeUndefined()
    expect(result.incidents.length).toBe(0)
    expect(result.summary.activeIncidents).toBe(0)
  })

  it('counts 429 as error for route status', async () => {
    const spans: TelemetrySpan[] = []
    for (let i = 0; i < 19; i++) {
      spans.push(makeSpan({
        spanId: `ok-${i}`,
        spanKind: 2,
        httpRoute: '/api/charge',
        httpMethod: 'POST',
        httpStatusCode: 200,
      }))
    }
    spans.push(makeSpan({
      spanId: 'rate-limited',
      spanKind: 2,
      httpRoute: '/api/charge',
      httpMethod: 'POST',
      httpStatusCode: 429,
    }))

    const store = makeMockTelemetryStore(spans)
    const storage = makeMockStorage()

    const result = await buildRuntimeMap(store, storage)
    const route = result.services[0]!.routes[0]!
    expect(route.errorRate).toBeCloseTo(0.05, 5)
    expect(route.status).toBe('critical')
  })

  it('treats spanStatusCode=2 as error', async () => {
    const spans: TelemetrySpan[] = []
    for (let i = 0; i < 19; i++) {
      spans.push(makeSpan({
        spanId: `ok-${i}`,
        spanKind: 1,
        spanName: 'db.query',
        httpStatusCode: undefined,
      }))
    }
    spans.push(makeSpan({
      spanId: 'status-err',
      spanKind: 1,
      spanName: 'db.query',
      spanStatusCode: 2,
      httpStatusCode: undefined,
    }))

    const store = makeMockTelemetryStore(spans)
    const storage = makeMockStorage()

    const result = await buildRuntimeMap(store, storage)
    expect(result.services[0]!.metrics.errorRate).toBeCloseTo(0.05, 5)
  })

  it('treats exceptionCount > 0 as error', async () => {
    const spans: TelemetrySpan[] = []
    for (let i = 0; i < 19; i++) {
      spans.push(makeSpan({
        spanId: `ok-${i}`,
        spanKind: 1,
        spanName: 'process',
      }))
    }
    spans.push(makeSpan({
      spanId: 'exc-err',
      spanKind: 1,
      spanName: 'process',
      exceptionCount: 3,
    }))

    const store = makeMockTelemetryStore(spans)
    const storage = makeMockStorage()

    const result = await buildRuntimeMap(store, storage)
    expect(result.services[0]!.metrics.errorRate).toBeCloseTo(0.05, 5)
  })

  it('creates runtime_unit contribution in service for INTERNAL spans', async () => {
    const span = makeSpan({
      spanId: 's1',
      spanKind: 1, // INTERNAL
      spanName: 'db.query',
      serviceName: 'api',
    })
    const store = makeMockTelemetryStore([span])
    const storage = makeMockStorage()

    const result = await buildRuntimeMap(store, storage)

    // The service "api" should exist (from the runtime_unit)
    expect(result.services).toHaveLength(1)
    expect(result.services[0]!.serviceName).toBe('api')
    // No routes (no SERVER spans)
    expect(result.services[0]!.routes).toHaveLength(0)
    // Not in dependencies
    expect(result.dependencies).toHaveLength(0)
  })

  it('creates service for spans with no spanKind', async () => {
    const span = makeSpan({
      spanId: 's1',
      spanKind: undefined,
      spanName: 'background.task',
      serviceName: 'worker',
    })
    const store = makeMockTelemetryStore([span])
    const storage = makeMockStorage()

    const result = await buildRuntimeMap(store, storage)

    expect(result.services).toHaveLength(1)
    expect(result.services[0]!.serviceName).toBe('worker')
    expect(result.services[0]!.routes).toHaveLength(0)
  })

  it('window reflects query parameters', async () => {
    const span = makeSpan({ spanId: 's1', spanKind: 1, spanName: 'op' })
    const store = makeMockTelemetryStore([span])
    const storage = makeMockStorage()

    const result = await buildRuntimeMap(store, storage, 15) // 15 minute window

    expect(result.services).toHaveLength(1)
  })
})
