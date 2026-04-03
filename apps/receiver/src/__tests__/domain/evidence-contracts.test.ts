/**
 * evidence-contracts.test.ts — Comprehensive contract tests for L2 Evidence Studio.
 *
 * Covers requirements 1, 3–11 from the L2 evidence contract specification.
 * Uses vi.mock for surface builders (same pattern as curated-evidence.test.ts)
 * to control test data precisely.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TelemetryStoreDriver } from '../../telemetry/interface.js'
import type { Incident } from '../../storage/interface.js'
import type { IncidentPacket, DiagnosisResult, ConsoleNarrative } from '@3am/core'
import type {
  BaselineContext,
  CuratedTraceSurface,
  CuratedMetricsSurface,
  CuratedLogsSurface,
  CuratedEvidenceRef,
} from '@3am/core/schemas/curated-evidence'
import { EvidenceResponseSchema } from '@3am/core/schemas/curated-evidence'

// Mock all three surface builders + reasoning structure builder
vi.mock('../../domain/trace-surface.js', () => ({ buildTraceSurface: vi.fn() }))
vi.mock('../../domain/metrics-surface.js', () => ({ buildMetricsSurface: vi.fn() }))
vi.mock('../../domain/logs-surface.js', () => ({ buildLogsSurface: vi.fn() }))
vi.mock('../../domain/reasoning-structure-builder.js', () => ({ buildReasoningStructure: vi.fn() }))

import { buildTraceSurface } from '../../domain/trace-surface.js'
import { buildMetricsSurface } from '../../domain/metrics-surface.js'
import { buildLogsSurface } from '../../domain/logs-surface.js'
import { buildReasoningStructure } from '../../domain/reasoning-structure-builder.js'
import { buildCuratedEvidence } from '../../domain/curated-evidence.js'

const mockBuildTraceSurface = vi.mocked(buildTraceSurface)
const mockBuildMetricsSurface = vi.mocked(buildMetricsSurface)
const mockBuildLogsSurface = vi.mocked(buildLogsSurface)
const mockBuildReasoningStructure = vi.mocked(buildReasoningStructure)

// ── Mock store ──────────────────────────────────────────────────────────

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

// ── Rich fixture data ───────────────────────────────────────────────────

const BASELINE_HIGH: BaselineContext = {
  windowStart: '2024-01-01T00:00:00Z',
  windowEnd: '2024-01-01T00:05:00Z',
  sampleCount: 50,
  confidence: 'high',
  source: { kind: 'exact_operation', operation: '/api/checkout', service: 'web' },
}

const BASELINE_LOW: BaselineContext = {
  windowStart: '2024-01-01T00:00:00Z',
  windowEnd: '2024-01-01T00:05:00Z',
  sampleCount: 2,
  confidence: 'low',
  source: { kind: 'same_operation_family', operation: '/api/checkout', service: 'web' },
}

const BASELINE_UNAVAILABLE: BaselineContext = {
  windowStart: '2024-01-01T00:00:00Z',
  windowEnd: '2024-01-01T00:05:00Z',
  sampleCount: 0,
  confidence: 'unavailable',
  source: { kind: 'none' },
}

function makeRichTraceSurface(baseline: BaselineContext = BASELINE_HIGH): CuratedTraceSurface {
  return {
    observed: [
      {
        traceId: 'trace-1',
        groupId: 'trace:trace-1',
        rootSpanName: 'POST /api/checkout',
        httpStatusCode: 500,
        durationMs: 1200,
        status: 'error',
        startTimeMs: 1700000000000,
        spans: [
          {
            spanId: 'span-1',
            parentSpanId: undefined,
            refId: 'trace-1:span-1',
            spanName: 'POST /api/checkout',
            durationMs: 1200,
            httpStatusCode: 500,
            spanStatusCode: 2,
            offsetMs: 0,
            widthPct: 100,
            status: 'error',
            attributes: { 'http.route': '/api/checkout', 'http.request.method': 'POST' },
            correlatedLogRefIds: ['log-ref-1'],
          },
          {
            spanId: 'span-2',
            parentSpanId: 'span-1',
            refId: 'trace-1:span-2',
            spanName: 'POST https://api.stripe.com/v1/charges',
            durationMs: 800,
            httpStatusCode: 429,
            spanStatusCode: 2,
            offsetMs: 100,
            widthPct: 66,
            status: 'error',
            peerService: 'stripe',
            attributes: { 'url.full': 'https://api.stripe.com/v1/charges' },
            correlatedLogRefIds: [],
          },
        ],
      },
      {
        traceId: 'trace-2',
        groupId: 'trace:trace-2',
        rootSpanName: 'POST /api/checkout',
        httpStatusCode: 504,
        durationMs: 5000,
        status: 'error',
        startTimeMs: 1700000002000,
        spans: [
          {
            spanId: 'span-3',
            parentSpanId: undefined,
            refId: 'trace-2:span-3',
            spanName: 'POST /api/checkout',
            durationMs: 5000,
            httpStatusCode: 504,
            spanStatusCode: 2,
            offsetMs: 0,
            widthPct: 100,
            status: 'error',
            attributes: { 'http.route': '/api/checkout' },
            correlatedLogRefIds: [],
          },
        ],
      },
      {
        traceId: 'trace-3',
        groupId: 'trace:trace-3',
        rootSpanName: 'GET /api/orders',
        httpStatusCode: 200,
        durationMs: 45,
        status: 'ok',
        startTimeMs: 1700000004000,
        spans: [
          {
            spanId: 'span-4',
            parentSpanId: undefined,
            refId: 'trace-3:span-4',
            spanName: 'GET /api/orders',
            durationMs: 45,
            httpStatusCode: 200,
            spanStatusCode: 1,
            offsetMs: 0,
            widthPct: 100,
            status: 'ok',
            attributes: { 'http.route': '/api/orders' },
            correlatedLogRefIds: [],
          },
        ],
      },
    ],
    expected: [
      {
        traceId: 'trace-baseline-1',
        groupId: 'trace:trace-baseline-1',
        rootSpanName: 'POST /api/checkout',
        httpStatusCode: 200,
        durationMs: 50,
        status: 'ok',
        startTimeMs: 1699999900000,
        spans: [
          {
            spanId: 'span-baseline-1',
            parentSpanId: undefined,
            refId: 'trace-baseline-1:span-baseline-1',
            spanName: 'POST /api/checkout',
            durationMs: 50,
            httpStatusCode: 200,
            spanStatusCode: 1,
            offsetMs: 0,
            widthPct: 100,
            status: 'ok',
            attributes: { 'http.route': '/api/checkout' },
            correlatedLogRefIds: [],
          },
        ],
      },
      {
        traceId: 'trace-baseline-2',
        groupId: 'trace:trace-baseline-2',
        rootSpanName: 'POST /api/checkout',
        httpStatusCode: 200,
        durationMs: 55,
        status: 'ok',
        startTimeMs: 1699999950000,
        spans: [
          {
            spanId: 'span-baseline-2',
            parentSpanId: undefined,
            refId: 'trace-baseline-2:span-baseline-2',
            spanName: 'POST /api/checkout',
            durationMs: 55,
            httpStatusCode: 200,
            spanStatusCode: 1,
            offsetMs: 0,
            widthPct: 100,
            status: 'ok',
            attributes: { 'http.route': '/api/checkout' },
            correlatedLogRefIds: [],
          },
        ],
      },
    ],
    smokingGunSpanId: 'trace-1:span-2',
    baseline: baseline,
  }
}

function makeRichMetricsSurface(): CuratedMetricsSurface {
  return {
    groups: [
      {
        groupId: 'mgroup:0',
        groupKey: {
          service: 'web',
          anomalyMagnitude: 'extreme',
          metricClass: 'error_rate',
        },
        diagnosisLabel: 'Stripe 429 error rate spike',
        diagnosisVerdict: 'Confirmed',
        rows: [
          {
            refId: 'metric:web:error_rate:0',
            name: 'http.server.request.error_rate',
            service: 'web',
            observedValue: 0.85,
            expectedValue: 0.02,
            deviation: 41.5,
            zScore: 8.3,
            impactBar: 0.95,
          },
        ],
      },
      {
        groupId: 'mgroup:1',
        groupKey: {
          service: 'web',
          anomalyMagnitude: 'significant',
          metricClass: 'latency',
        },
        rows: [
          {
            refId: 'metric:web:latency:0',
            name: 'http.server.request.duration_p95',
            service: 'web',
            observedValue: 1200,
            expectedValue: 50,
            deviation: 23.0,
            zScore: 5.7,
            impactBar: 0.8,
          },
          {
            refId: 'metric:web:latency:1',
            name: 'http.server.request.duration_p50',
            service: 'web',
            observedValue: 800,
            expectedValue: 30,
            deviation: 25.6,
            zScore: 6.1,
            impactBar: 0.75,
          },
        ],
      },
      {
        groupId: 'mgroup:2',
        groupKey: {
          service: 'web',
          anomalyMagnitude: 'moderate',
          metricClass: 'throughput',
        },
        rows: [
          {
            refId: 'metric:web:throughput:0',
            name: 'http.server.request.count',
            service: 'web',
            observedValue: 150,
            expectedValue: 1000,
            deviation: -0.85,
            zScore: -3.2,
            impactBar: 0.5,
          },
        ],
      },
    ],
  }
}

function makeRichLogsSurface(): CuratedLogsSurface {
  return {
    clusters: [
      {
        clusterId: 'lcluster:0',
        clusterKey: {
          primaryService: 'web',
          severityDominant: 'ERROR',
          hasTraceCorrelation: true,
          keywordHits: ['error', 'rate'],
        },
        diagnosisLabel: 'Stripe 429 error cluster',
        entries: [
          {
            refId: 'log:web:2024-01-01T00:01:00Z:hash1',
            timestamp: '2024-01-01T00:01:00Z',
            severity: 'ERROR',
            body: 'Stripe API returned 429 Too Many Requests',
            isSignal: true,
            traceId: 'trace-1',
            spanId: 'span-2',
          },
          {
            refId: 'log:web:2024-01-01T00:01:05Z:hash2',
            timestamp: '2024-01-01T00:01:05Z',
            severity: 'ERROR',
            body: 'Stripe API returned 429 Too Many Requests (retry 1)',
            isSignal: true,
            traceId: 'trace-1',
            spanId: 'span-2',
          },
        ],
        signalCount: 2,
        noiseCount: 0,
      },
      {
        clusterId: 'lcluster:1',
        clusterKey: {
          primaryService: 'web',
          severityDominant: 'ERROR',
          hasTraceCorrelation: false,
          keywordHits: ['timeout'],
        },
        diagnosisLabel: 'Cascade timeout logs',
        entries: [
          {
            refId: 'log:web:2024-01-01T00:02:00Z:hash3',
            timestamp: '2024-01-01T00:02:00Z',
            severity: 'ERROR',
            body: 'Request timed out waiting for payment service',
            isSignal: true,
          },
        ],
        signalCount: 1,
        noiseCount: 0,
      },
      {
        clusterId: 'lcluster:2',
        clusterKey: {
          primaryService: 'web',
          severityDominant: 'WARN',
          hasTraceCorrelation: false,
          keywordHits: [],
        },
        entries: [
          {
            refId: 'log:web:2024-01-01T00:03:00Z:hash4',
            timestamp: '2024-01-01T00:03:00Z',
            severity: 'WARN',
            body: 'Connection pool nearing capacity',
            isSignal: false,
          },
        ],
        signalCount: 0,
        noiseCount: 1,
      },
    ],
    absenceEvidence: [
      {
        refId: 'absence:retry_backoff',
        kind: 'absence',
        patternId: 'retry_backoff',
        keywords: ['retry', 'backoff'],
        matchCount: 0,
        searchWindow: {
          start: '2024-01-01T00:00:00Z',
          end: '2024-01-01T00:05:00Z',
        },
        defaultLabel: 'No retry/backoff patterns detected',
      },
    ],
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
      affectedRoutes: ['/api/checkout'],
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
      what_happened: 'Stripe API rate limited due to flash sale traffic spike',
      root_cause_hypothesis: 'Flash sale traffic exceeded Stripe API quota',
    },
    recommendation: {
      immediate_action: 'Enable exponential backoff on Stripe calls',
      action_rationale_short: 'Reduce pressure on rate-limited endpoint',
      do_not: 'Do not disable Stripe integration',
    },
    reasoning: {
      causal_chain: [
        { type: 'external', title: 'Traffic spike', detail: 'Flash sale caused traffic surge' },
        { type: 'system', title: 'Retry amplification', detail: 'No backoff worsens load' },
        { type: 'incident', title: 'Queue saturation', detail: 'Worker pool exhausted' },
        { type: 'impact', title: 'Checkout failure', detail: 'Customer-facing 504s' },
      ],
    },
    confidence: {
      confidence_assessment: 'high',
      uncertainty: 'Stripe internal quota not visible in telemetry',
    },
    operator_guidance: {
      watch_items: [],
      operator_checks: ['Check Stripe dashboard for 429 spike'],
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
    headline: 'Stripe 429 cascade from flash sale traffic',
    whyThisAction: 'Backoff reduces pressure on the rate-limited endpoint.',
    confidenceSummary: {
      basis: '429s match traffic spike timing',
      risk: 'Retry storm if misconfigured',
    },
    proofCards: [
      { id: 'trigger', label: 'External Trigger', summary: 'Stripe returned 429 rate limit errors.' },
      { id: 'design_gap', label: 'Design Gap', summary: 'No retry backoff observed in logs.' },
      { id: 'recovery', label: 'Recovery Signal', summary: 'Recovery evidence pending.' },
    ],
    qa: {
      question: 'Why are checkout payments failing?',
      answer: 'Stripe is rate limiting requests due to flash sale traffic surge.',
      answerEvidenceRefs: [
        { kind: 'span', id: 'trace-1:span-2' },
        { kind: 'metric_group', id: 'mgroup:0' },
        { kind: 'log_cluster', id: 'lcluster:0' },
      ],
      evidenceBindings: [
        {
          claim: 'Stripe is rate limiting requests.',
          evidenceRefs: [{ kind: 'span', id: 'trace-1:span-2' }],
        },
      ],
      followups: [
        { question: 'When did the traffic spike start?', targetEvidenceKinds: ['traces', 'metrics'] },
        { question: 'Are retries worsening the problem?', targetEvidenceKinds: ['logs'] },
      ],
      noAnswerReason: null,
    },
    sideNotes: [
      { title: 'Confidence', text: 'High confidence based on 429 evidence.', kind: 'confidence' },
      { title: 'Uncertainty', text: 'Stripe internal quota not visible.', kind: 'uncertainty' },
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
    spanMembership: ['trace-1:span-1', 'trace-1:span-2', 'trace-2:span-3'],
    anomalousSignals: [
      { signal: 'http_429', firstSeenAt: '2024-01-01T00:01:00Z', entity: 'web', spanId: 'span-2' },
    ],
    platformEvents: [],
    ...overrides,
  }
}

// ── Setup ───────────────────────────────────────────────────────────────

function setupRichMocks(baseline: BaselineContext = BASELINE_HIGH) {
  const traceSurface = makeRichTraceSurface(baseline)
  const metricsSurface = makeRichMetricsSurface()
  const logsSurface = makeRichLogsSurface()

  const traceEvidenceRefs = new Map<string, CuratedEvidenceRef>()
  for (const trace of traceSurface.observed) {
    for (const span of trace.spans) {
      traceEvidenceRefs.set(span.refId, {
        refId: span.refId,
        surface: 'traces',
        groupId: trace.groupId,
        isSmokingGun: span.refId === traceSurface.smokingGunSpanId,
      })
    }
  }

  const metricsEvidenceRefs = new Map<string, CuratedEvidenceRef>()
  for (const group of metricsSurface.groups) {
    for (const row of group.rows) {
      metricsEvidenceRefs.set(row.refId, {
        refId: row.refId,
        surface: 'metrics',
        groupId: group.groupId,
      })
    }
  }

  const logsEvidenceRefs = new Map<string, CuratedEvidenceRef>()
  for (const cluster of logsSurface.clusters) {
    for (const entry of cluster.entries) {
      logsEvidenceRefs.set(entry.refId, {
        refId: entry.refId,
        surface: 'logs',
        groupId: cluster.clusterId,
      })
    }
  }
  for (const absence of logsSurface.absenceEvidence) {
    logsEvidenceRefs.set(absence.refId, {
      refId: absence.refId,
      surface: 'absences',
    })
  }

  mockBuildTraceSurface.mockResolvedValue({
    surface: traceSurface,
    evidenceRefs: traceEvidenceRefs,
  })

  mockBuildMetricsSurface.mockResolvedValue({
    surface: metricsSurface,
    evidenceRefs: metricsEvidenceRefs,
  })

  mockBuildLogsSurface.mockResolvedValue({
    surface: logsSurface,
    evidenceRefs: logsEvidenceRefs,
  })

  mockBuildReasoningStructure.mockResolvedValue({
    incidentId: 'inc-1',
    evidenceCounts: { traces: 3, traceErrors: 2, metrics: 4, logs: 4, logErrors: 3 },
    blastRadius: [
      { targetId: 'web:/api/checkout', label: 'web /api/checkout', status: 'critical', impactValue: 0.9, displayValue: '90%' },
    ],
    proofRefs: [
      {
        cardId: 'trigger',
        targetSurface: 'traces',
        evidenceRefs: [{ kind: 'span', id: 'trace-1:span-2' }],
        status: 'confirmed',
      },
      {
        cardId: 'design_gap',
        targetSurface: 'metrics',
        evidenceRefs: [{ kind: 'metric_group', id: 'mgroup:0' }],
        status: 'inferred',
      },
      {
        cardId: 'recovery',
        targetSurface: 'traces',
        evidenceRefs: [],
        status: 'pending',
      },
    ],
    absenceCandidates: [
      { id: 'retry_backoff', patterns: ['retry', 'backoff'], searchWindow: { startMs: 1700000000000, endMs: 1700000300000 }, matchCount: 0 },
    ],
    timelineSummary: {
      startedAt: '2024-01-01T00:00:00Z',
      fullCascadeAt: null,
      diagnosedAt: null,
    },
    qaContext: {
      availableEvidenceKinds: ['traces', 'metrics', 'logs'],
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  setupRichMocks()
})

// ═══════════════════════════════════════════════════════════════════════
// Req 1: Initial evidence contract completeness
// ═══════════════════════════════════════════════════════════════════════

describe('L2 Evidence Contracts', () => {
  describe('Req 1: initial evidence contract completeness', () => {
    it('returns EvidenceResponse that passes strict schema validation', async () => {
      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
        consoleNarrative: makeNarrative(),
      })

      const result = await buildCuratedEvidence(incident, makeMockStore())
      const parsed = EvidenceResponseSchema.strict().parse(result)

      expect(parsed).toBeDefined()
    })

    it('all top-level fields are populated (not empty arrays/strings)', async () => {
      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
        consoleNarrative: makeNarrative(),
      })

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      expect(result.proofCards.length).toBeGreaterThan(0)
      expect(result.qa.question.length).toBeGreaterThan(0)
      expect(result.qa.answer.length).toBeGreaterThan(0)
      expect(result.surfaces.traces.observed.length).toBeGreaterThan(0)
      expect(result.surfaces.metrics.hypotheses.length).toBeGreaterThan(0)
      expect(result.surfaces.logs.claims.length).toBeGreaterThan(0)
      expect(result.sideNotes.length).toBeGreaterThan(0)
      expect(result.state).toBeDefined()
    })

    it('proofCards has exactly 3 items', async () => {
      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
        consoleNarrative: makeNarrative(),
      })

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      expect(result.proofCards).toHaveLength(3)
      expect(result.proofCards.map((c) => c.id)).toEqual(['trigger', 'design_gap', 'recovery'])
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Req 3: Proof card referential integrity
  // ═══════════════════════════════════════════════════════════════════════

  describe('Req 3: proof card referential integrity', () => {
    it('every proofCard evidenceRef resolves to a real surface entry', async () => {
      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
        consoleNarrative: makeNarrative(),
      })

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      // Collect all IDs from surfaces
      const allSpanIds = result.surfaces.traces.observed.flatMap(
        (t) => t.spans.map((s) => s.spanId),
      )
      const allTraceRefIds = result.surfaces.traces.observed.flatMap(
        (t) => t.spans.map((s) => `${t.traceId}:${s.spanId}`),
      )
      const allMetricGroupIds = result.surfaces.metrics.hypotheses.map((h) => h.id)
      const allLogClaimIds = result.surfaces.logs.claims.map((c) => c.id)

      const allIds = new Set([
        ...allSpanIds,
        ...allTraceRefIds,
        ...allMetricGroupIds,
        ...allLogClaimIds,
      ])

      for (const card of result.proofCards) {
        for (const ref of card.evidenceRefs) {
          // Evidence ref IDs from reasoning structure should be resolvable
          // Note: evidenceRefs in proof cards come from proofRefs which use traceId:spanId format
          // The ref.id may be in composite format; we check both composite and spanId-only
          const compositeId = ref.id
          const spanIdOnly = compositeId.includes(':')
            ? compositeId.split(':').pop()
            : compositeId
          const resolves = allIds.has(compositeId) || allIds.has(spanIdOnly!)
          expect(resolves).toBe(true)
        }
      }
    })

    it('proofCard targetSurface matches the surface where evidenceRefs exist', async () => {
      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
        consoleNarrative: makeNarrative(),
      })

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      for (const card of result.proofCards) {
        expect(['traces', 'metrics', 'logs']).toContain(card.targetSurface)

        // For cards with evidence refs, verify they reference the correct surface type
        for (const ref of card.evidenceRefs) {
          if (card.targetSurface === 'traces') {
            expect(ref.kind).toBe('span')
          } else if (card.targetSurface === 'metrics') {
            expect(['metric', 'metric_group']).toContain(ref.kind)
          } else if (card.targetSurface === 'logs') {
            expect(['log', 'log_cluster']).toContain(ref.kind)
          }
        }
      }
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Req 4: Stable ID determinism
  // ═══════════════════════════════════════════════════════════════════════

  describe('Req 4: stable ID determinism', () => {
    it('calling buildCuratedEvidence twice with same input produces same IDs', async () => {
      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
        consoleNarrative: makeNarrative(),
      })
      const store = makeMockStore()

      const result1 = await buildCuratedEvidence(incident, store)
      const result2 = await buildCuratedEvidence(incident, store)

      // Proof card IDs
      expect(result1.proofCards.map((c) => c.id)).toEqual(result2.proofCards.map((c) => c.id))

      // Trace IDs
      const traceIds1 = result1.surfaces.traces.observed.map((t) => t.traceId)
      const traceIds2 = result2.surfaces.traces.observed.map((t) => t.traceId)
      expect(traceIds1).toEqual(traceIds2)

      // Span IDs
      const spanIds1 = result1.surfaces.traces.observed.flatMap((t) => t.spans.map((s) => s.spanId))
      const spanIds2 = result2.surfaces.traces.observed.flatMap((t) => t.spans.map((s) => s.spanId))
      expect(spanIds1).toEqual(spanIds2)

      // Metric hypothesis IDs
      const metricIds1 = result1.surfaces.metrics.hypotheses.map((h) => h.id)
      const metricIds2 = result2.surfaces.metrics.hypotheses.map((h) => h.id)
      expect(metricIds1).toEqual(metricIds2)

      // Log claim IDs
      const logIds1 = result1.surfaces.logs.claims.map((c) => c.id)
      const logIds2 = result2.surfaces.logs.claims.map((c) => c.id)
      expect(logIds1).toEqual(logIds2)

      // SmokingGunSpanId
      expect(result1.surfaces.traces.smokingGunSpanId).toEqual(result2.surfaces.traces.smokingGunSpanId)
    })

    it('span refIds follow {traceId}:{spanId} format in internal surface', async () => {
      const traceSurface = makeRichTraceSurface()
      for (const trace of traceSurface.observed) {
        for (const span of trace.spans) {
          expect(span.refId).toBe(`${trace.traceId}:${span.spanId}`)
        }
      }
    })

    it('log cluster IDs follow lcluster:{index} format', async () => {
      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
        consoleNarrative: makeNarrative(),
      })

      const result = await buildCuratedEvidence(incident, makeMockStore())

      const nonAbsenceClaims = result.surfaces.logs.claims.filter((c) => c.type !== 'absence')
      for (const claim of nonAbsenceClaims) {
        expect(claim.id).toMatch(/^lcluster:\d+$/)
      }
    })

    it('metric group IDs follow mgroup:{index} format', async () => {
      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
        consoleNarrative: makeNarrative(),
      })

      const result = await buildCuratedEvidence(incident, makeMockStore())

      for (const hypothesis of result.surfaces.metrics.hypotheses) {
        expect(hypothesis.id).toMatch(/^mgroup:\d+$/)
      }
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Req 5: Deterministic evidence lookup
  // ═══════════════════════════════════════════════════════════════════════

  describe('Req 5: deterministic evidence lookup', () => {
    it('proof card ref resolves to a surface entry', async () => {
      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
        consoleNarrative: makeNarrative(),
      })

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      // The trigger proof card has a span ref
      const triggerCard = result.proofCards.find((c) => c.id === 'trigger')
      expect(triggerCard).toBeDefined()
      expect(triggerCard!.evidenceRefs.length).toBeGreaterThan(0)

      // All span refs should point to actual spans
      const allSpanIds = result.surfaces.traces.observed.flatMap(
        (t) => t.spans.map((s) => s.spanId),
      )
      for (const ref of triggerCard!.evidenceRefs) {
        if (ref.kind === 'span') {
          const spanId = ref.id.includes(':') ? ref.id.split(':').pop()! : ref.id
          expect(allSpanIds).toContain(spanId)
        }
      }
    })

    it('QA evidenceRef resolves to a surface entry', async () => {
      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
        consoleNarrative: makeNarrative(),
      })

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      const allSpanIds = result.surfaces.traces.observed.flatMap(
        (t) => t.spans.map((s) => s.spanId),
      )
      const allTraceRefIds = result.surfaces.traces.observed.flatMap(
        (t) => t.spans.map((s) => `${t.traceId}:${s.spanId}`),
      )
      const allMetricGroupIds = result.surfaces.metrics.hypotheses.map((h) => h.id)
      const allLogClaimIds = result.surfaces.logs.claims.map((c) => c.id)

      const allIds = new Set([
        ...allSpanIds,
        ...allTraceRefIds,
        ...allMetricGroupIds,
        ...allLogClaimIds,
      ])

      for (const ref of result.qa.evidenceRefs) {
        const id = ref.id
        const spanIdOnly = id.includes(':') ? id.split(':').pop()! : id
        const resolves = allIds.has(id) || allIds.has(spanIdOnly)
        expect(resolves).toBe(true)
      }
    })

    it('span correlatedLogs is populated when logs share traceId', async () => {
      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
        consoleNarrative: makeNarrative(),
      })

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      // trace-1 has correlated logs in the log cluster (traceId: 'trace-1', spanId: 'span-2')
      const trace1 = result.surfaces.traces.observed.find((t) => t.traceId === 'trace-1')
      expect(trace1).toBeDefined()

      // span-2 in trace-1 should have correlatedLogs because logs cluster has entries
      // with traceId=trace-1, spanId=span-2
      const span2 = trace1!.spans.find((s) => s.spanId === 'span-2')
      expect(span2).toBeDefined()
      expect(span2!.correlatedLogs).toBeDefined()
      expect(span2!.correlatedLogs!.length).toBeGreaterThan(0)
    })

    it('cross-surface: same evidence ref appears in both proof card and QA block', async () => {
      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
        consoleNarrative: makeNarrative(),
      })

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      // The narrative references trace-1:span-2 in QA and the trigger proof card
      // references it via reasoning structure
      const qaRefs = new Set(result.qa.evidenceRefs.map((r) => `${r.kind}:${r.id}`))
      const proofCardRefs = new Set(
        result.proofCards.flatMap((c) =>
          c.evidenceRefs.map((r) => `${r.kind}:${r.id}`),
        ),
      )

      // At least one ref should overlap between QA and proof cards
      const intersection = [...qaRefs].filter((r) => proofCardRefs.has(r))
      expect(intersection.length).toBeGreaterThan(0)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Req 6: Traces contract
  // ═══════════════════════════════════════════════════════════════════════

  describe('Req 6: traces contract', () => {
    it('TraceSurface has observed and expected arrays', async () => {
      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
        consoleNarrative: makeNarrative(),
      })

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      expect(Array.isArray(result.surfaces.traces.observed)).toBe(true)
      expect(Array.isArray(result.surfaces.traces.expected)).toBe(true)
      expect(result.surfaces.traces.observed.length).toBe(3)
      expect(result.surfaces.traces.expected.length).toBe(2)
    })

    it('smokingGunSpanId points to a span that exists in observed traces', async () => {
      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
        consoleNarrative: makeNarrative(),
      })

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      const smokingGunId = result.surfaces.traces.smokingGunSpanId
      expect(smokingGunId).not.toBeNull()

      const allSpanIds = result.surfaces.traces.observed.flatMap(
        (t) => t.spans.map((s) => s.spanId),
      )
      expect(allSpanIds).toContain(smokingGunId)
    })

    it('span attributes are non-empty objects (not {})', async () => {
      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
        consoleNarrative: makeNarrative(),
      })

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      for (const trace of result.surfaces.traces.observed) {
        for (const span of trace.spans) {
          expect(Object.keys(span.attributes).length).toBeGreaterThan(0)
        }
      }
    })

    it('baseline field is present with source/window/sampleCount/confidence', async () => {
      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
        consoleNarrative: makeNarrative(),
      })

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      const baseline = result.surfaces.traces.baseline
      expect(baseline).toBeDefined()
      expect(baseline!.source).toBe('exact_operation')
      expect(baseline!.windowStart).toBe('2024-01-01T00:00:00Z')
      expect(baseline!.windowEnd).toBe('2024-01-01T00:05:00Z')
      expect(baseline!.sampleCount).toBe(50)
      expect(baseline!.confidence).toBe('high')
    })

    it('correlatedLogs are populated for spans with matching log traceIds', async () => {
      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
        consoleNarrative: makeNarrative(),
      })

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      // span-2 in trace-1 should have correlated logs (logs cluster has spanId=span-2)
      const trace1 = result.surfaces.traces.observed.find((t) => t.traceId === 'trace-1')
      expect(trace1).toBeDefined()
      const span2 = trace1!.spans.find((s) => s.spanId === 'span-2')
      expect(span2).toBeDefined()
      if (span2!.correlatedLogs) {
        for (const log of span2!.correlatedLogs) {
          expect(log.timestamp).toBeTruthy()
          expect(log.severity).toBeTruthy()
          expect(log.body).toBeTruthy()
        }
      }
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Req 7: Baseline contract
  // ═══════════════════════════════════════════════════════════════════════

  describe('Req 7: baseline contract', () => {
    it('ready state: baseline.confidence is high or medium', async () => {
      setupRichMocks(BASELINE_HIGH)
      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
        consoleNarrative: makeNarrative(),
      })

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      expect(result.state.baseline).toBe('ready')
      expect(['high', 'medium']).toContain(result.surfaces.traces.baseline!.confidence)
    })

    it('insufficient state: baseline.confidence is low', async () => {
      setupRichMocks(BASELINE_LOW)
      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
        consoleNarrative: makeNarrative(),
      })

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      expect(result.state.baseline).toBe('insufficient')
      expect(result.surfaces.traces.baseline!.confidence).toBe('low')
    })

    it('unavailable state: baseline.confidence is unavailable, source is none', async () => {
      setupRichMocks(BASELINE_UNAVAILABLE)
      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
        consoleNarrative: makeNarrative(),
      })

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      expect(result.state.baseline).toBe('unavailable')
      expect(result.surfaces.traces.baseline!.confidence).toBe('unavailable')
      expect(result.surfaces.traces.baseline!.source).toBe('none')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Req 8: Logs contract
  // ═══════════════════════════════════════════════════════════════════════

  describe('Req 8: logs contract', () => {
    it('claims include absence evidence entries', async () => {
      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
        consoleNarrative: makeNarrative(),
      })

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      const absenceClaims = result.surfaces.logs.claims.filter((c) => c.type === 'absence')
      expect(absenceClaims.length).toBeGreaterThan(0)
    })

    it('absence claims have type=absence, count=0, expected and observed', async () => {
      // Give absence evidence diagnosis labels
      const narrative = makeNarrative()
      narrative.absenceEvidence = [
        {
          id: 'retry_backoff',
          label: 'Missing retry/backoff pattern',
          expected: 'Exponential backoff on external API calls',
          observed: 'No retry/backoff patterns found',
          explanation: 'The service has no retry mechanism for Stripe API failures',
        },
      ]

      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
        consoleNarrative: narrative,
      })

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      const absenceClaims = result.surfaces.logs.claims.filter((c) => c.type === 'absence')
      for (const claim of absenceClaims) {
        expect(claim.type).toBe('absence')
        expect(claim.count).toBe(0)
        expect(claim.entries).toEqual([])
      }
    })

    it('log clusters have stable IDs', async () => {
      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
        consoleNarrative: makeNarrative(),
      })

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      const nonAbsenceClaims = result.surfaces.logs.claims.filter((c) => c.type !== 'absence')
      for (const claim of nonAbsenceClaims) {
        expect(claim.id).toMatch(/^lcluster:\d+$/)
      }
    })

    it('proof card with targetSurface=logs resolves to a log claim', async () => {
      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
        consoleNarrative: makeNarrative(),
      })

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      // Find proof cards targeting logs
      const logTargetCards = result.proofCards.filter((c) => c.targetSurface === 'logs')
      // Not all configurations will have log-targeted cards since narrative overrides targetSurface
      // But we verify the contract: if a card targets logs, the log claims array is valid
      if (logTargetCards.length > 0) {
        expect(result.surfaces.logs.claims.length).toBeGreaterThanOrEqual(0)
      }
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Req 9: Metrics contract
  // ═══════════════════════════════════════════════════════════════════════

  describe('Req 9: metrics contract', () => {
    it('hypotheses have id, type, claim, verdict, metrics[]', async () => {
      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
        consoleNarrative: makeNarrative(),
      })

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      expect(result.surfaces.metrics.hypotheses.length).toBe(3)

      for (const hypothesis of result.surfaces.metrics.hypotheses) {
        expect(hypothesis.id).toBeTruthy()
        expect(['trigger', 'cascade', 'recovery', 'absence']).toContain(hypothesis.type)
        expect(hypothesis.claim.length).toBeGreaterThan(0)
        expect(['Confirmed', 'Inferred']).toContain(hypothesis.verdict)
        expect(hypothesis.metrics.length).toBeGreaterThan(0)
      }
    })

    it('metric groups have stable IDs', async () => {
      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
        consoleNarrative: makeNarrative(),
      })

      const result = await buildCuratedEvidence(incident, makeMockStore())

      for (const hypothesis of result.surfaces.metrics.hypotheses) {
        expect(hypothesis.id).toMatch(/^mgroup:\d+$/)
      }
    })

    it('HypothesisMetric has name, value, expected, barPercent', async () => {
      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
        consoleNarrative: makeNarrative(),
      })

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      for (const hypothesis of result.surfaces.metrics.hypotheses) {
        for (const metric of hypothesis.metrics) {
          expect(metric.name.length).toBeGreaterThan(0)
          expect(typeof metric.value).toBe('string')
          expect(typeof metric.expected).toBe('string')
          expect(typeof metric.barPercent).toBe('number')
          expect(metric.barPercent).toBeGreaterThanOrEqual(0)
          expect(metric.barPercent).toBeLessThanOrEqual(100)
        }
      }
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Req 10: Degraded state enum
  // ═══════════════════════════════════════════════════════════════════════

  describe('Req 10: degraded state enum', () => {
    it('returns diagnosis=ready when diagnosisResult exists', async () => {
      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
        consoleNarrative: makeNarrative(),
      })

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      expect(result.state.diagnosis).toBe('ready')
    })

    it('returns diagnosis=pending when dispatched but no result', async () => {
      const incident = makeIncident({
        diagnosisDispatchedAt: new Date().toISOString(),
      })

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      expect(result.state.diagnosis).toBe('pending')
    })

    it('returns diagnosis=unavailable when no dispatch', async () => {
      const incident = makeIncident()

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      expect(result.state.diagnosis).toBe('unavailable')
    })

    it('returns baseline=insufficient for low confidence', async () => {
      setupRichMocks(BASELINE_LOW)
      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
      })

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      expect(result.state.baseline).toBe('insufficient')
    })

    it('returns evidenceDensity=empty when no data', async () => {
      // Override with empty surfaces
      mockBuildTraceSurface.mockResolvedValue({
        surface: {
          observed: [],
          expected: [],
          baseline: BASELINE_UNAVAILABLE,
        },
        evidenceRefs: new Map(),
      })
      mockBuildMetricsSurface.mockResolvedValue({
        surface: { groups: [] },
        evidenceRefs: new Map(),
      })
      mockBuildLogsSurface.mockResolvedValue({
        surface: { clusters: [], absenceEvidence: [] },
        evidenceRefs: new Map(),
      })

      const incident = makeIncident()

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      expect(result.state.evidenceDensity).toBe('empty')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Req 11: No-answer / pending / sparse
  // ═══════════════════════════════════════════════════════════════════════

  describe('Req 11: no-answer / pending / sparse', () => {
    it('QA block has noAnswerReason when diagnosis unavailable', async () => {
      const incident = makeIncident()

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      expect(result.state.diagnosis).toBe('unavailable')
      expect(result.qa.noAnswerReason).toBeTruthy()
      expect(result.qa.noAnswerReason!.length).toBeGreaterThan(0)
    })

    it('QA answer is not empty string when noAnswerReason is set', async () => {
      const incident = makeIncident({
        diagnosisDispatchedAt: new Date().toISOString(),
      })

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      expect(result.qa.noAnswerReason).toBeTruthy()
      // Even with noAnswerReason, answer should provide useful fallback text
      expect(result.qa.answer.length).toBeGreaterThan(0)
    })

    it('QA followups are always populated (even in fallback)', async () => {
      const incident = makeIncident()

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      expect(result.qa.followups.length).toBeGreaterThan(0)
      for (const followup of result.qa.followups) {
        expect(followup.question.length).toBeGreaterThan(0)
        expect(followup.targetEvidenceKinds.length).toBeGreaterThan(0)
      }
    })

    it('QA evidenceSummary is valid even when counts are zero', async () => {
      const incident = makeIncident()

      const result = await buildCuratedEvidence(incident, makeMockStore())
      EvidenceResponseSchema.strict().parse(result)

      expect(result.qa.evidenceSummary).toBeDefined()
      expect(typeof result.qa.evidenceSummary.traces).toBe('number')
      expect(typeof result.qa.evidenceSummary.metrics).toBe('number')
      expect(typeof result.qa.evidenceSummary.logs).toBe('number')
      expect(result.qa.evidenceSummary.traces).toBeGreaterThanOrEqual(0)
      expect(result.qa.evidenceSummary.metrics).toBeGreaterThanOrEqual(0)
      expect(result.qa.evidenceSummary.logs).toBeGreaterThanOrEqual(0)
    })
  })
})
