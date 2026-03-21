/**
 * Tests for curated-evidence.ts — orchestrator for GET /api/incidents/:id/evidence.
 *
 * Mocks all 3 surface builders and verifies:
 *   1. All surfaces assembled correctly
 *   2. EvidenceIndex merges refs by surface category
 *   3. proofCards = [], qa = null, sideNotes = []
 *   4. State: diagnosis ready/pending/unavailable
 *   5. State: baseline maps from trace surface confidence
 *   6. Empty incident produces empty surfaces
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TelemetryStoreDriver } from '../../telemetry/interface.js'
import type { Incident } from '../../storage/interface.js'
import type {
  IncidentPacket,
  TraceSurface,
  MetricsSurface,
  LogsSurface,
  EvidenceRef,
  BaselineContext,
  DiagnosisResult,
} from '@3amoncall/core'

// ── Mock surface builders ──────────────────────────────────────────────

vi.mock('../../domain/trace-surface.js', () => ({
  buildTraceSurface: vi.fn(),
}))

vi.mock('../../domain/metrics-surface.js', () => ({
  buildMetricsSurface: vi.fn(),
}))

vi.mock('../../domain/logs-surface.js', () => ({
  buildLogsSurface: vi.fn(),
}))

import { buildTraceSurface } from '../../domain/trace-surface.js'
import { buildMetricsSurface } from '../../domain/metrics-surface.js'
import { buildLogsSurface } from '../../domain/logs-surface.js'
import { buildCuratedEvidence } from '../../domain/curated-evidence.js'

const mockBuildTraceSurface = vi.mocked(buildTraceSurface)
const mockBuildMetricsSurface = vi.mocked(buildMetricsSurface)
const mockBuildLogsSurface = vi.mocked(buildLogsSurface)

// ── Helpers ─────────────────────────────────────────────────────────────

function makeMockStore(): TelemetryStoreDriver {
  return {
    querySpans: vi.fn().mockResolvedValue([]),
    queryMetrics: vi.fn().mockResolvedValue([]),
    queryLogs: vi.fn().mockResolvedValue([]),
    ingestSpans: vi.fn().mockResolvedValue(undefined),
    ingestMetrics: vi.fn().mockResolvedValue(undefined),
    ingestLogs: vi.fn().mockResolvedValue(undefined),
    upsertSnapshot: vi.fn().mockResolvedValue(undefined),
    getSnapshots: vi.fn().mockResolvedValue([]),
    deleteSnapshots: vi.fn().mockResolvedValue(undefined),
    deleteExpired: vi.fn().mockResolvedValue(undefined),
  }
}

function makeMinimalPacket(overrides: Partial<IncidentPacket> = {}): IncidentPacket {
  return {
    schemaVersion: 'incident-packet/v1alpha1',
    packetId: 'pkt-1',
    incidentId: 'inc-1',
    openedAt: '2024-01-01T00:00:00Z',
    window: {
      start: '2024-01-01T00:00:00Z',
      detect: '2024-01-01T00:01:00Z',
      end: '2024-01-01T00:05:00Z',
    },
    scope: {
      environment: 'production',
      primaryService: 'web',
      affectedServices: ['web'],
      affectedRoutes: ['/api/orders'],
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
    ...overrides,
  }
}

function makeIncident(overrides: Partial<Incident> = {}): Incident {
  return {
    incidentId: 'inc-1',
    status: 'open',
    openedAt: '2024-01-01T00:00:00Z',
    packet: makeMinimalPacket(),
    telemetryScope: {
      windowStartMs: 1700000000000,
      windowEndMs: 1700000300000,
      detectTimeMs: 1700000060000,
      environment: 'production',
      memberServices: ['web'],
      dependencyServices: ['stripe'],
    },
    spanMembership: ['trace-1:span-1'],
    anomalousSignals: [],
    platformEvents: [],
    ...overrides,
  }
}

function makeDiagnosisResult(): DiagnosisResult {
  return {
    summary: {
      what_happened: 'Stripe API rate limited',
      root_cause_hypothesis: 'Flash sale traffic spike',
    },
    recommendation: {
      immediate_action: 'Enable backoff',
      action_rationale_short: 'Reduce pressure',
      do_not: 'Do not disable Stripe integration',
    },
    reasoning: {
      causal_chain: [
        { type: 'external', title: 'Traffic spike', detail: 'Flash sale' },
      ],
    },
    confidence: {
      confidence_assessment: 'high',
      uncertainty: 'Low — clear correlation between traffic spike and 429s',
    },
    operator_guidance: {
      watch_items: [{ label: 'Stripe 429s', state: 'active', status: 'critical' }],
      operator_checks: ['Check Stripe dashboard for rate limit status'],
    },
    metadata: {
      model: 'claude-sonnet-4-5-20251001',
      created_at: '2024-01-01T00:10:00Z',
      incident_id: 'inc-1',
      packet_id: 'pkt-1',
      prompt_version: 'v5',
    },
  }
}

const EMPTY_BASELINE_CONTEXT: BaselineContext = {
  windowStart: '2024-01-01T00:00:00Z',
  windowEnd: '2024-01-01T00:05:00Z',
  sampleCount: 0,
  confidence: 'unavailable',
  source: { kind: 'none' },
}

function makeEmptyTraceSurface(baseline: BaselineContext = EMPTY_BASELINE_CONTEXT): TraceSurface {
  return {
    observed: [],
    expected: [],
    baseline,
  }
}

function makeEmptyMetricsSurface(): MetricsSurface {
  return { groups: [] }
}

function makeEmptyLogsSurface(): LogsSurface {
  return { clusters: [], absenceEvidence: [] }
}

// ── Setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()

  mockBuildTraceSurface.mockResolvedValue({
    surface: makeEmptyTraceSurface(),
    evidenceRefs: new Map(),
  })

  mockBuildMetricsSurface.mockResolvedValue({
    surface: makeEmptyMetricsSurface(),
    evidenceRefs: new Map(),
  })

  mockBuildLogsSurface.mockResolvedValue({
    surface: makeEmptyLogsSurface(),
    evidenceRefs: new Map(),
  })
})

// ── Tests ────────────────────────────────────────────────────────────────

describe('buildCuratedEvidence', () => {
  it('assembles all 3 surfaces correctly', async () => {
    const traceSurface = makeEmptyTraceSurface()
    const metricsSurface = makeEmptyMetricsSurface()
    const logsSurface = makeEmptyLogsSurface()

    mockBuildTraceSurface.mockResolvedValue({ surface: traceSurface, evidenceRefs: new Map() })
    mockBuildMetricsSurface.mockResolvedValue({ surface: metricsSurface, evidenceRefs: new Map() })
    mockBuildLogsSurface.mockResolvedValue({ surface: logsSurface, evidenceRefs: new Map() })

    const incident = makeIncident()
    const store = makeMockStore()

    const result = await buildCuratedEvidence(incident, store)

    expect(result.surfaces.traces).toBe(traceSurface)
    expect(result.surfaces.metrics).toBe(metricsSurface)
    expect(result.surfaces.logs).toBe(logsSurface)
  })

  it('merges EvidenceIndex refs from all surfaces into correct categories', async () => {
    const spanRef: EvidenceRef = { refId: 'trace-1:span-1', surface: 'traces', groupId: 'trace:trace-1' }
    const metricRef: EvidenceRef = { refId: 'web:error_rate:123', surface: 'metrics', groupId: 'mgroup:0' }
    const logRef: EvidenceRef = { refId: 'web:2024-01-01T00:00:00Z:abc123', surface: 'logs', groupId: 'lcluster:0' }
    const absenceRef: EvidenceRef = { refId: 'abs:pattern-1', surface: 'absences', groupId: 'lcluster:1' }

    const traceRefs = new Map<string, EvidenceRef>([['trace-1:span-1', spanRef]])
    const metricRefs = new Map<string, EvidenceRef>([['web:error_rate:123', metricRef]])
    // Logs surface returns both log and absence refs
    const logRefs = new Map<string, EvidenceRef>([
      ['web:2024-01-01T00:00:00Z:abc123', logRef],
      ['abs:pattern-1', absenceRef],
    ])

    mockBuildTraceSurface.mockResolvedValue({ surface: makeEmptyTraceSurface(), evidenceRefs: traceRefs })
    mockBuildMetricsSurface.mockResolvedValue({ surface: makeEmptyMetricsSurface(), evidenceRefs: metricRefs })
    mockBuildLogsSurface.mockResolvedValue({ surface: makeEmptyLogsSurface(), evidenceRefs: logRefs })

    const result = await buildCuratedEvidence(makeIncident(), makeMockStore())

    expect(result.evidenceIndex.spans).toEqual({ 'trace-1:span-1': spanRef })
    expect(result.evidenceIndex.metrics).toEqual({ 'web:error_rate:123': metricRef })
    expect(result.evidenceIndex.logs).toEqual({ 'web:2024-01-01T00:00:00Z:abc123': logRef })
    expect(result.evidenceIndex.absences).toEqual({ 'abs:pattern-1': absenceRef })
  })

  it('returns proofCards = [], qa = null, sideNotes = []', async () => {
    const result = await buildCuratedEvidence(makeIncident(), makeMockStore())

    expect(result.proofCards).toEqual([])
    expect(result.qa).toBeNull()
    expect(result.sideNotes).toEqual([])
  })

  it('sets diagnosis state to "ready" when diagnosisResult exists', async () => {
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })

    const result = await buildCuratedEvidence(incident, makeMockStore())

    expect(result.state.diagnosis).toBe('ready')
  })

  it('sets diagnosis state to "pending" when diagnosisDispatchedAt set without result', async () => {
    const incident = makeIncident({
      diagnosisDispatchedAt: '2024-01-01T00:05:00Z',
      diagnosisResult: undefined,
    })

    const result = await buildCuratedEvidence(incident, makeMockStore())

    expect(result.state.diagnosis).toBe('pending')
  })

  it('sets diagnosis state to "unavailable" when no dispatch and no result', async () => {
    const incident = makeIncident({
      diagnosisDispatchedAt: undefined,
      diagnosisResult: undefined,
    })

    const result = await buildCuratedEvidence(incident, makeMockStore())

    expect(result.state.diagnosis).toBe('unavailable')
  })

  it('maps baseline confidence "high" to state "ready"', async () => {
    const baseline: BaselineContext = {
      ...EMPTY_BASELINE_CONTEXT,
      confidence: 'high',
      sampleCount: 50,
      source: { kind: 'same_route', route: '/api/orders', service: 'web' },
    }
    mockBuildTraceSurface.mockResolvedValue({
      surface: makeEmptyTraceSurface(baseline),
      evidenceRefs: new Map(),
    })

    const result = await buildCuratedEvidence(makeIncident(), makeMockStore())

    expect(result.state.baseline).toBe('ready')
  })

  it('maps baseline confidence "medium" to state "ready"', async () => {
    const baseline: BaselineContext = {
      ...EMPTY_BASELINE_CONTEXT,
      confidence: 'medium',
      sampleCount: 20,
      source: { kind: 'same_service', service: 'web' },
    }
    mockBuildTraceSurface.mockResolvedValue({
      surface: makeEmptyTraceSurface(baseline),
      evidenceRefs: new Map(),
    })

    const result = await buildCuratedEvidence(makeIncident(), makeMockStore())

    expect(result.state.baseline).toBe('ready')
  })

  it('maps baseline confidence "low" to state "insufficient"', async () => {
    const baseline: BaselineContext = {
      ...EMPTY_BASELINE_CONTEXT,
      confidence: 'low',
      sampleCount: 3,
      source: { kind: 'same_service', service: 'web' },
    }
    mockBuildTraceSurface.mockResolvedValue({
      surface: makeEmptyTraceSurface(baseline),
      evidenceRefs: new Map(),
    })

    const result = await buildCuratedEvidence(makeIncident(), makeMockStore())

    expect(result.state.baseline).toBe('insufficient')
  })

  it('maps baseline confidence "unavailable" to state "unavailable"', async () => {
    // Default mock already returns unavailable
    const result = await buildCuratedEvidence(makeIncident(), makeMockStore())

    expect(result.state.baseline).toBe('unavailable')
  })

  it('returns empty surfaces and unavailable state for incident with no telemetry', async () => {
    const incident = makeIncident({
      spanMembership: [],
      anomalousSignals: [],
    })

    const result = await buildCuratedEvidence(incident, makeMockStore())

    expect(result.surfaces.traces).toEqual(makeEmptyTraceSurface())
    expect(result.surfaces.metrics).toEqual(makeEmptyMetricsSurface())
    expect(result.surfaces.logs).toEqual(makeEmptyLogsSurface())
    expect(result.evidenceIndex.spans).toEqual({})
    expect(result.evidenceIndex.metrics).toEqual({})
    expect(result.evidenceIndex.logs).toEqual({})
    expect(result.evidenceIndex.absences).toEqual({})
    expect(result.state.diagnosis).toBe('unavailable')
    expect(result.state.baseline).toBe('unavailable')
    expect(result.state.evidenceDensity).toBe('empty')
  })

  it('calls all 3 surface builders with correct arguments', async () => {
    const incident = makeIncident()
    const store = makeMockStore()

    await buildCuratedEvidence(incident, store)

    expect(mockBuildTraceSurface).toHaveBeenCalledWith(incident, store)
    expect(mockBuildMetricsSurface).toHaveBeenCalledWith(
      store,
      incident.telemetryScope,
      incident.anomalousSignals,
    )
    expect(mockBuildLogsSurface).toHaveBeenCalledWith(
      store,
      incident.telemetryScope,
      incident.anomalousSignals,
      incident.spanMembership,
    )
  })

  it('computes evidenceDensity as "empty" when all surfaces are empty', async () => {
    const result = await buildCuratedEvidence(makeIncident(), makeMockStore())
    expect(result.state.evidenceDensity).toBe('empty')
  })

  it('computes evidenceDensity as "sparse" when some evidence exists', async () => {
    const traceSurface: TraceSurface = {
      observed: [{ traceId: 't1', groupId: 'trace:t1', rootSpanName: 'GET /', durationMs: 100, status: 'ok', startTimeMs: 0, spans: [] }],
      expected: [],
      baseline: EMPTY_BASELINE_CONTEXT,
    }
    mockBuildTraceSurface.mockResolvedValue({ surface: traceSurface, evidenceRefs: new Map() })

    const result = await buildCuratedEvidence(makeIncident(), makeMockStore())
    expect(result.state.evidenceDensity).toBe('sparse')
  })

  it('prioritizes diagnosisResult over diagnosisDispatchedAt for state', async () => {
    // Both set — diagnosisResult wins
    const incident = makeIncident({
      diagnosisResult: makeDiagnosisResult(),
      diagnosisDispatchedAt: '2024-01-01T00:05:00Z',
    })

    const result = await buildCuratedEvidence(incident, makeMockStore())

    expect(result.state.diagnosis).toBe('ready')
  })
})
