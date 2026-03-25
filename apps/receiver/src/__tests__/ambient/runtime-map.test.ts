import { describe, it, expect, vi } from 'vitest'
import {
  buildRuntimeMap,
  normalizeRoute,
  normalizeSpanName,
  normalizePeerService,
} from '../../ambient/runtime-map.js'
import type { TelemetrySpan, TelemetryStoreDriver } from '../../telemetry/interface.js'
import type { StorageDriver, Incident } from '../../storage/interface.js'
import type { IncidentPacket } from '@3amoncall/core'

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
    createIncident: vi.fn(),
    updatePacket: vi.fn(),
    updateIncidentStatus: vi.fn(),
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
    expect(result.nodes).toEqual([])
    expect(result.edges).toEqual([])
    expect(result.summary.activeIncidents).toBe(0)
    expect(result.summary.degradedNodes).toBe(0)
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
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0]!.id).toContain('/checkout')
    expect(result.summary.activeIncidents).toBe(1)
  })

  it('creates entry_point node from SERVER span with httpRoute', async () => {
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

    expect(result.nodes.length).toBe(1)
    expect(result.nodes[0]!.tier).toBe('entry_point')
    expect(result.nodes[0]!.id).toBe('route:api:GET:/users')
    expect(result.nodes[0]!.label).toBe('GET /users')
    expect(result.edges).toEqual([])
  })

  it('creates runtime_unit + dependency from CLIENT span with peerService', async () => {
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

    expect(result.nodes.length).toBe(2)
    const unit = result.nodes.find((n) => n.tier === 'runtime_unit')!
    const dep = result.nodes.find((n) => n.tier === 'dependency')!
    expect(unit!.id).toBe('unit:api:stripe.charges.create')
    expect(dep!.id).toBe('dep:stripe')
    expect(dep!.label).toBe('stripe')

    // Should have 1 edge: unit → dependency
    expect(result.edges.length).toBe(1)
    expect(result.edges[0]!.fromNodeId).toBe(unit!.id)
    expect(result.edges[0]!.toNodeId).toBe(dep!.id)
    expect(result.edges[0]!.kind).toBe('external')
  })

  it('collapses multiple spans with same route into 1 node with aggregated metrics', async () => {
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

    expect(result.nodes.length).toBe(1)
    const node = result.nodes[0]!
    expect(node.metrics.errorRate).toBeCloseTo(0.1, 5) // 1/10
    expect(node.metrics.p95Ms).toBe(100) // p95 of [10..100]
    expect(node.metrics.reqPerSec).toBeGreaterThan(0)
  })

  it('sets status to critical when errorRate >= 0.05', async () => {
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
    expect(result.nodes[0]!.status).toBe('critical')
    expect(result.nodes[0]!.metrics.errorRate).toBeCloseTo(0.05, 5)
  })

  it('sets status to degraded when errorRate >= 0.01 but < 0.05', async () => {
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
    expect(result.nodes[0]!.status).toBe('degraded')
  })

  it('deduplicates edges with same from/to', async () => {
    // Two CLIENT spans to the same dependency — should produce 1 merged edge
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

    // 1 unit + 1 dep = 2 nodes
    expect(result.nodes.length).toBe(2)
    // 1 merged edge
    expect(result.edges.length).toBe(1)
    expect(result.edges[0]!.trafficHint).toBe('2')
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

    // Both spans map to the same node, so no edge should be created
    expect(result.nodes.length).toBe(1)
    expect(result.edges.length).toBe(0)
  })

  it('builds parent-child edges between different nodes', async () => {
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

    expect(result.nodes.length).toBe(2)
    expect(result.edges.length).toBe(1)
    expect(result.edges[0]!.fromNodeId).toBe('route:api:POST:/checkout')
    expect(result.edges[0]!.toNodeId).toBe('unit:api:process-payment')
    expect(result.edges[0]!.kind).toBe('internal')
  })

  it('calculates summary correctly', async () => {
    // 2 entry_point nodes, 1 healthy + 1 degraded
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

    // Also add 1 internal span to push total > 100
    spans.push(makeSpan({
      spanId: 'internal-1',
      spanKind: 1,
      spanName: 'db.query',
      serviceName: 'api',
    }))

    const store = makeMockTelemetryStore(spans)
    const storage = makeMockStorage()

    const result = await buildRuntimeMap(store, storage)

    expect(result.summary.degradedNodes).toBe(1) // /orders is degraded
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

  it('assigns incidentId to matching nodes when open incident exists', async () => {
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

    // entry_point node should be matched by primaryService "api"
    const entryNode = result.nodes.find((n) => n.tier === 'entry_point')!
    expect(entryNode.incidentId).toBe('inc-1')

    // dependency node should be matched by affectedDependencies "stripe"
    const depNode = result.nodes.find((n) => n.tier === 'dependency')!
    expect(depNode.incidentId).toBe('inc-1')

    // runtime_unit node should be matched by affectedServices
    const unitNode = result.nodes.find((n) => n.tier === 'runtime_unit')!
    expect(unitNode.incidentId).toBe('inc-1')

    // incidents list should have the open incident
    expect(result.incidents.length).toBe(1)
    expect(result.incidents[0]!.incidentId).toBe('inc-1')
  })

  it('does not assign closed incidents to nodes', async () => {
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

    const node = result.nodes[0]!
    expect(node.incidentId).toBeUndefined()
    expect(result.incidents.length).toBe(0)
    expect(result.summary.activeIncidents).toBe(0)
  })

  it('counts 429 as error for node status', async () => {
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
    expect(result.nodes[0]!.metrics.errorRate).toBeCloseTo(0.05, 5)
    expect(result.nodes[0]!.status).toBe('critical')
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
    expect(result.nodes[0]!.metrics.errorRate).toBeCloseTo(0.05, 5)
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
    expect(result.nodes[0]!.metrics.errorRate).toBeCloseTo(0.05, 5)
  })

  it('creates runtime_unit for INTERNAL spans', async () => {
    const span = makeSpan({
      spanId: 's1',
      spanKind: 1, // INTERNAL
      spanName: 'db.query',
      serviceName: 'api',
    })
    const store = makeMockTelemetryStore([span])
    const storage = makeMockStorage()

    const result = await buildRuntimeMap(store, storage)

    expect(result.nodes.length).toBe(1)
    expect(result.nodes[0]!.tier).toBe('runtime_unit')
    expect(result.nodes[0]!.id).toBe('unit:api:db.query')
  })

  it('creates runtime_unit for spans with no spanKind', async () => {
    const span = makeSpan({
      spanId: 's1',
      spanKind: undefined,
      spanName: 'background.task',
      serviceName: 'worker',
    })
    const store = makeMockTelemetryStore([span])
    const storage = makeMockStorage()

    const result = await buildRuntimeMap(store, storage)

    expect(result.nodes.length).toBe(1)
    expect(result.nodes[0]!.tier).toBe('runtime_unit')
    expect(result.nodes[0]!.id).toBe('unit:worker:background.task')
  })

  it('window reflects query parameters', async () => {
    const span = makeSpan({ spanId: 's1', spanKind: 1, spanName: 'op' })
    const store = makeMockTelemetryStore([span])
    const storage = makeMockStorage()

    const result = await buildRuntimeMap(store, storage, 15) // 15 minute window

    expect(result.nodes.length).toBe(1)
  })
})
