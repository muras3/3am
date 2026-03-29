import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TelemetryStoreDriver } from '../../telemetry/interface.js'
import type { Incident } from '../../storage/interface.js'
import type { IncidentPacket, DiagnosisResult, ConsoleNarrative } from '@3amoncall/core'
import type {
  BaselineContext,
  CuratedTraceSurface,
  CuratedMetricsSurface,
  CuratedLogsSurface,
  CuratedEvidenceRef,
} from '@3amoncall/core/schemas/curated-evidence'

vi.mock('../../domain/trace-surface.js', () => ({ buildTraceSurface: vi.fn() }))
vi.mock('../../domain/metrics-surface.js', () => ({ buildMetricsSurface: vi.fn() }))
vi.mock('../../domain/logs-surface.js', () => ({ buildLogsSurface: vi.fn() }))

import { buildTraceSurface } from '../../domain/trace-surface.js'
import { buildMetricsSurface } from '../../domain/metrics-surface.js'
import { buildLogsSurface } from '../../domain/logs-surface.js'
import { buildCuratedEvidence } from '../../domain/curated-evidence.js'

const mockBuildTraceSurface = vi.mocked(buildTraceSurface)
const mockBuildMetricsSurface = vi.mocked(buildMetricsSurface)
const mockBuildLogsSurface = vi.mocked(buildLogsSurface)

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
    deleteExpiredSnapshots: vi.fn().mockResolvedValue(undefined),
  }
}

function makePacket(): IncidentPacket {
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
      causal_chain: [{ type: 'external', title: 'Traffic spike', detail: 'Flash sale' }],
    },
    confidence: {
      confidence_assessment: 'high',
      uncertainty: 'Low uncertainty',
    },
    operator_guidance: {
      watch_items: [],
      operator_checks: ['Check Stripe dashboard'],
    },
    metadata: {
      model: 'test-model',
      created_at: '2024-01-01T00:10:00Z',
      incident_id: 'inc-1',
      packet_id: 'pkt-1',
      prompt_version: 'v5',
    },
  }
}

function makeNarrative(): ConsoleNarrative {
  return {
    headline: 'Stripe 429 cascade',
    whyThisAction: 'Backoff reduces pressure.',
    confidenceSummary: {
      basis: '429s match traffic spike',
      risk: 'Retry storm if misconfigured',
    },
    proofCards: [
      { id: 'trigger', label: 'External Trigger', summary: 'Stripe 429s observed.' },
      { id: 'design_gap', label: 'Design Gap', summary: 'No batching found.' },
      { id: 'recovery', label: 'Recovery Signal', summary: 'Recovery evidence pending.' },
    ],
    qa: {
      question: 'Why are payments failing?',
      answer: 'Stripe is rate limiting requests.',
      answerEvidenceRefs: [
        { kind: 'span', id: 'trace-1:span-1' },
        { kind: 'metric_group', id: 'mgroup:0' },
      ],
      evidenceBindings: [
        { claim: 'Stripe is rate limiting requests.', evidenceRefs: [{ kind: 'span', id: 'trace-1:span-1' }] },
      ],
      followups: [
        { question: 'Did this start with a traffic spike?', targetEvidenceKinds: ['traces', 'metrics'] },
      ],
      noAnswerReason: null,
    },
    sideNotes: [
      { title: 'Confidence', text: 'High confidence', kind: 'confidence' },
    ],
    absenceEvidence: [],
    metadata: {
      model: 'test-model',
      prompt_version: 'narrative-v1',
      created_at: '2024-01-01T00:10:00Z',
      stage1_packet_id: 'pkt-1',
    },
  }
}

function makeIncident(overrides: Partial<Incident> = {}): Incident {
  return {
    incidentId: 'inc-1',
    status: 'open',
    openedAt: '2024-01-01T00:00:00Z',
    lastActivityAt: '2024-01-01T00:00:00Z',
    packet: makePacket(),
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

const EMPTY_BASELINE: BaselineContext = {
  windowStart: '2024-01-01T00:00:00Z',
  windowEnd: '2024-01-01T00:05:00Z',
  sampleCount: 0,
  confidence: 'unavailable',
  source: { kind: 'none' },
}

function makeTraceSurface(baseline: BaselineContext = EMPTY_BASELINE): CuratedTraceSurface {
  return {
    observed: [],
    expected: [],
    baseline,
  }
}

function makeMetricsSurface(): CuratedMetricsSurface {
  return { groups: [] }
}

function makeLogsSurface(): CuratedLogsSurface {
  return { clusters: [], absenceEvidence: [] }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockBuildTraceSurface.mockResolvedValue({ surface: makeTraceSurface(), evidenceRefs: new Map() })
  mockBuildMetricsSurface.mockResolvedValue({ surface: makeMetricsSurface(), evidenceRefs: new Map() })
  mockBuildLogsSurface.mockResolvedValue({ surface: makeLogsSurface(), evidenceRefs: new Map() })
})

describe('buildCuratedEvidence', () => {
  it('projects internal surfaces to the public evidence contract', async () => {
    mockBuildTraceSurface.mockResolvedValue({
      surface: {
        observed: [{
          traceId: 'trace-1',
          groupId: 'trace:trace-1',
          rootSpanName: 'POST /checkout',
          httpStatusCode: 500,
          durationMs: 1200,
          status: 'error',
          startTimeMs: 0,
          spans: [{
            spanId: 'span-1',
            parentSpanId: undefined,
            refId: 'trace-1:span-1',
            spanName: 'POST /checkout',
            durationMs: 1200,
            httpStatusCode: 500,
            spanStatusCode: 2,
            offsetMs: 0,
            widthPct: 100,
            status: 'error',
            attributes: { route: '/checkout' },
            correlatedLogRefIds: [],
          }],
        }],
        expected: [],
        smokingGunSpanId: 'trace-1:span-1',
        baseline: EMPTY_BASELINE,
      },
      evidenceRefs: new Map<string, CuratedEvidenceRef>(),
    })

    const result = await buildCuratedEvidence(makeIncident(), makeMockStore())

    expect(result.surfaces.traces.observed[0]?.route).toBe('POST /checkout')
    // extractSpanId extracts spanId from "traceId:spanId" composite format
    expect(result.surfaces.traces.smokingGunSpanId).toBe('span-1')
    expect(result.surfaces.metrics.hypotheses).toEqual([])
    expect(result.surfaces.logs.claims).toEqual([])
  })

  it('derives state from diagnosis, baseline, and evidence density', async () => {
    mockBuildTraceSurface.mockResolvedValue({
      surface: makeTraceSurface({
        ...EMPTY_BASELINE,
        confidence: 'high',
        sampleCount: 50,
        source: { kind: 'same_service', service: 'web' },
      }),
      evidenceRefs: new Map(),
    })

    const result = await buildCuratedEvidence(
      makeIncident({ diagnosisResult: makeDiagnosisResult() }),
      makeMockStore(),
    )

    expect(result.state).toEqual({
      diagnosis: 'ready',
      baseline: 'ready',
      evidenceDensity: 'empty',
    })
  })

  it('maps narrative QA and side notes into the public response', async () => {
    const result = await buildCuratedEvidence(
      makeIncident({
        diagnosisResult: makeDiagnosisResult(),
        consoleNarrative: makeNarrative(),
      }),
      makeMockStore(),
    )

    expect(result.qa.question).toBe('Why are payments failing?')
    expect(result.qa.evidenceSummary).toEqual({ traces: 1, metrics: 1, logs: 0 })
    expect(result.qa.followups[0]?.question).toBe('Did this start with a traffic spike?')
    expect(result.sideNotes[0]).toEqual({
      title: 'Confidence',
      text: 'High confidence',
      kind: 'confidence',
    })
  })

  it('builds deterministic qa and proof-card placeholders when narrative is missing', async () => {
    const result = await buildCuratedEvidence(
      makeIncident({
        diagnosisDispatchedAt: '2024-01-01T00:02:00Z',
      }),
      makeMockStore(),
    )

    expect(result.proofCards).toHaveLength(3)
    expect(result.proofCards.map((card) => card.id)).toEqual(['trigger', 'design_gap', 'recovery'])
    expect(result.proofCards.every((card) => card.summary.length > 0)).toBe(true)
    expect(result.proofCards.map((card) => card.targetSurface)).toEqual(['traces', 'metrics', 'traces'])
    expect(result.qa.question).toContain('web /api/orders')
    expect(result.qa.noAnswerReason).toContain('Diagnosis narrative is pending')
  })

  it('calls all three surface builders with the expected arguments', async () => {
    const incident = makeIncident()
    const store = makeMockStore()

    await buildCuratedEvidence(incident, store)

    expect(mockBuildTraceSurface).toHaveBeenCalledWith(incident, store)
    expect(mockBuildMetricsSurface).toHaveBeenCalledWith(store, incident.telemetryScope, incident.anomalousSignals)
    expect(mockBuildLogsSurface).toHaveBeenCalledWith(store, incident.telemetryScope, incident.anomalousSignals, incident.spanMembership)
  })

  it('public trace surface includes baseline field from internal surface', async () => {
    const richBaseline: BaselineContext = {
      windowStart: '2024-01-01T00:00:00Z',
      windowEnd: '2024-01-01T00:05:00Z',
      sampleCount: 50,
      confidence: 'high',
      source: { kind: 'same_route', route: '/checkout', service: 'web' },
    }

    mockBuildTraceSurface.mockResolvedValue({
      surface: {
        observed: [{
          traceId: 'trace-1',
          groupId: 'trace:trace-1',
          rootSpanName: 'POST /checkout',
          httpStatusCode: 500,
          durationMs: 1200,
          status: 'error',
          startTimeMs: 0,
          spans: [{
            spanId: 'span-1',
            parentSpanId: undefined,
            refId: 'trace-1:span-1',
            spanName: 'POST /checkout',
            durationMs: 1200,
            httpStatusCode: 500,
            spanStatusCode: 2,
            offsetMs: 0,
            widthPct: 100,
            status: 'error',
            attributes: { route: '/checkout' },
            correlatedLogRefIds: [],
          }],
        }],
        expected: [],
        baseline: richBaseline,
      },
      evidenceRefs: new Map<string, CuratedEvidenceRef>(),
    })

    const result = await buildCuratedEvidence(makeIncident(), makeMockStore())

    expect(result.surfaces.traces.baseline).toBeDefined()
    expect(result.surfaces.traces.baseline!.source).toBe('same_route')
    expect(result.surfaces.traces.baseline!.sampleCount).toBe(50)
    expect(result.surfaces.traces.baseline!.confidence).toBe('high')
    expect(result.surfaces.traces.baseline!.windowStart).toBe('2024-01-01T00:00:00Z')
    expect(result.surfaces.traces.baseline!.windowEnd).toBe('2024-01-01T00:05:00Z')
  })

  it('log ref IDs in proof cards match logs surface entry refIds', async () => {
    // Set up a log surface with correlated entries and a trace with matching traceId
    mockBuildLogsSurface.mockResolvedValue({
      surface: {
        clusters: [{
          clusterId: 'lcluster:0',
          clusterKey: {
            primaryService: 'web',
            severityDominant: 'ERROR',
            hasTraceCorrelation: true,
            keywordHits: ['error'],
          },
          entries: [{
            refId: 'log:web:2024-01-01T00:01:00Z:hash1',
            timestamp: '2024-01-01T00:01:00Z',
            severity: 'ERROR',
            body: 'Stripe API call failed',
            isSignal: true,
            traceId: 'trace-1',
            spanId: 'span-1',
          }],
          signalCount: 1,
          noiseCount: 0,
        }],
        absenceEvidence: [],
      },
      evidenceRefs: new Map(),
    })

    const narrative = makeNarrative()
    const incident = makeIncident({
      diagnosisResult: makeDiagnosisResult(),
      consoleNarrative: narrative,
    })

    const result = await buildCuratedEvidence(incident, makeMockStore())

    // The log claims should contain the cluster
    expect(result.surfaces.logs.claims.length).toBeGreaterThan(0)
    const logClaim = result.surfaces.logs.claims.find((c) => c.id === 'lcluster:0')
    expect(logClaim).toBeDefined()
    expect(logClaim!.entries.length).toBe(1)
    expect(logClaim!.entries[0]!.body).toBe('Stripe API call failed')
  })
})
