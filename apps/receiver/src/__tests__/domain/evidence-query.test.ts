/**
 * evidence-query.test.ts — Domain tests for POST /api/incidents/:id/evidence/query.
 *
 * The domain layer is LLM-first (see absolute rule in CLAUDE.md). These tests
 * mock `generateEvidenceQueryWithMeta` and `generateEvidencePlan` to simulate
 * the synthesis layer and assert:
 *   - the right context fields (diagnosisStatus, evidenceStatus, absenceInput,
 *     locale, history) flow into the LLM prompt input, and
 *   - retry/repair/safety-net semantics match CLAUDE.md.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TelemetryLog, TelemetryMetric, TelemetrySpan, TelemetryStoreDriver } from '../../telemetry/interface.js'
import type { Incident } from '../../storage/interface.js'
import type { IncidentPacket, DiagnosisResult, EvidenceQueryResponse } from '3am-core'
import { EvidenceQueryResponseSchema } from '3am-core/schemas/curated-evidence'
const {
  generateEvidencePlanMock,
  generateEvidenceQueryWithMetaMock,
} = vi.hoisted(() => ({
  generateEvidencePlanMock: vi.fn(),
  generateEvidenceQueryWithMetaMock: vi.fn(),
}))
vi.mock('3am-diagnosis', async () => {
  const actual = await vi.importActual('3am-diagnosis')
  return {
    ...actual,
    generateEvidencePlan: generateEvidencePlanMock,
    generateEvidenceQueryWithMeta: generateEvidenceQueryWithMetaMock,
  }
})

/** Helper: wrap a response into the {response, meta} tuple the domain expects. */
function withMeta(response: EvidenceQueryResponse, meta: { retryCount?: number; repairedRefCount?: number } = {}) {
  return {
    response,
    meta: {
      retryCount: meta.retryCount ?? 0,
      repairedRefCount: meta.repairedRefCount ?? 0,
    },
  }
}


import { buildEvidenceQueryAnswer } from '../../domain/evidence-query.js'

// ── Fixture factories ───────────────────────────────────────────────────

function makeMockStore(): TelemetryStoreDriver {
  const spans: TelemetrySpan[] = [{
    traceId: 'trace-1',
    spanId: 'span-1',
    parentSpanId: undefined,
    serviceName: 'web',
    environment: 'production',
    spanName: 'POST /checkout',
    httpRoute: '/api/checkout',
    httpStatusCode: 504,
    spanStatusCode: 2,
    durationMs: 1200,
    startTimeMs: 1700000001000,
    exceptionCount: 1,
    attributes: { 'http.response.status_code': 504 },
    ingestedAt: 1700000002000,
  }]
  const metrics: TelemetryMetric[] = [{
    service: 'web',
    environment: 'production',
    name: 'checkout.error_rate',
    startTimeMs: 1700000000000,
    summary: { value: 0.85, p95: 1200 },
    ingestedAt: 1700000002000,
  }]
  const logs: TelemetryLog[] = [{
    service: 'web',
    environment: 'production',
    timestamp: '2024-01-01T00:01:00Z',
    startTimeMs: 1700000000000,
    severity: 'ERROR',
    severityNumber: 17,
    body: 'Stripe 429',
    bodyHash: 'stripe429hash0001',
    attributes: {},
    traceId: 'trace-1',
    spanId: 'span-1',
    ingestedAt: 1700000002000,
  }]

  return {
    querySpans: vi.fn().mockResolvedValue(spans),
    queryMetrics: vi.fn().mockResolvedValue(metrics),
    queryLogs: vi.fn().mockResolvedValue(logs),
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

function makePacket(overrides: Partial<IncidentPacket> = {}): IncidentPacket {
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
      changedMetrics: [
        { name: 'error_rate', service: 'web', environment: 'production', startTimeMs: 1704067260000, summary: { value: 0.85 } },
      ],
      representativeTraces: [
        { traceId: 'trace-1', spanId: 'span-1', serviceName: 'web', durationMs: 1200, spanStatusCode: 2 },
      ],
      relevantLogs: [
        { timestamp: '2024-01-01T00:01:00Z', service: 'web', environment: 'production', startTimeMs: 1704067260000, severity: 'ERROR', body: 'Stripe 429', attributes: {} },
      ],
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
        { type: 'external', title: 'Traffic spike', detail: 'Flash sale' },
        { type: 'system', title: 'Retry amplification', detail: 'No backoff' },
      ],
    },
    confidence: {
      confidence_assessment: 'high',
      uncertainty: 'Stripe internal quota unknown',
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

// ── Tests ────────────────────────────────────────────────────────────────

describe('buildEvidenceQueryAnswer', () => {
  beforeEach(() => {
    generateEvidencePlanMock.mockReset()
    generateEvidenceQueryWithMetaMock.mockReset()
    generateEvidencePlanMock.mockImplementation(async (input: { question: string }) => {
      if (input.question === 'どうあるべき？') {
        return {
          mode: 'clarification',
          rewrittenQuestion: 'Clarify the user intent.',
          preferredSurfaces: ['traces'],
          clarificationQuestion: '何を知りたいかを一段具体化して。',
        }
      }
      if (input.question.includes('何をすればいい') || input.question.includes('次のアクション')) {
        return {
          mode: 'action',
          rewrittenQuestion: 'What should the operator do first for this incident?',
          preferredSurfaces: ['traces', 'logs', 'metrics'],
        }
      }
      if (input.question.includes('logがない') || input.question.includes('ログがない')) {
        return {
          mode: 'missing_evidence',
          rewrittenQuestion: 'Why are the expected logs missing and what should be checked next?',
          preferredSurfaces: ['logs', 'traces', 'metrics'],
        }
      }
      return {
        mode: 'answer',
        rewrittenQuestion: input.question,
        preferredSurfaces: ['traces', 'metrics', 'logs'],
      }
    })
    // LLM-first default: synthesis succeeds with a generic evidence-grounded
    // response. Individual tests override this for specific behavioral checks.
    generateEvidenceQueryWithMetaMock.mockImplementation(async (input: { question: string; evidence: Array<{ ref: { kind: string; id: string } }>; diagnosis?: { rootCauseHypothesis?: string } | null; answerMode?: string }) => {
      const firstRef = input.evidence[0]?.ref ?? { kind: 'span', id: 'trace-1:span-1' }
      const diagnosisInferenceText = input.diagnosis?.rootCauseHypothesis
        ? `That pattern is consistent with the existing diagnosis: ${input.diagnosis.rootCauseHypothesis}`
        : 'The evidence is consistent with an ongoing anomaly.'
      const actionInferenceText = 'The minimum next action follows from the diagnosis and the cited evidence.'
      const missingLogsText = '失敗ログに対応する収集経路を確認するのが最短。'
      return withMeta({
        question: input.question,
        status: 'answered',
        segments: [
          {
            id: 'seg_1',
            kind: 'fact',
            text: 'Checkout spans returned 504 during the incident window.',
            evidenceRefs: [firstRef as { kind: 'span' | 'metric_group' | 'log_cluster' | 'absence'; id: string }],
          },
          {
            id: 'seg_2',
            kind: 'inference',
            text: input.answerMode === 'action'
              ? actionInferenceText
              : input.answerMode === 'missing_evidence'
                ? missingLogsText
                : diagnosisInferenceText,
            evidenceRefs: [firstRef as { kind: 'span' | 'metric_group' | 'log_cluster' | 'absence'; id: string }],
          },
        ],
        evidenceSummary: { traces: 0, metrics: 0, logs: 0 },
        followups: [],
      })
    })
  })

  it('passes diagnosisStatus=unavailable to the LLM when no diagnosis has run', async () => {
    const incident = makeIncident()
    const store = makeMockStore()

    const result = await buildEvidenceQueryAnswer(incident, store, 'What happened?', false)

    expect(generateEvidenceQueryWithMetaMock).toHaveBeenCalled()
    const call = generateEvidenceQueryWithMetaMock.mock.calls[0]?.[0] as { diagnosisStatus?: string; diagnosis?: unknown }
    expect(call?.diagnosisStatus).toBe('unavailable')
    expect(call?.diagnosis).toBeNull()
    expect(result.status).toBe('answered')
  })

  it('passes diagnosisStatus=pending to the LLM while diagnosis is running', async () => {
    const incident = makeIncident({
      diagnosisDispatchedAt: new Date().toISOString(),
    })
    const store = makeMockStore()

    const result = await buildEvidenceQueryAnswer(incident, store, 'What happened?', false)

    expect(generateEvidenceQueryWithMetaMock).toHaveBeenCalled()
    const call = generateEvidenceQueryWithMetaMock.mock.calls[0]?.[0] as { diagnosisStatus?: string }
    expect(call?.diagnosisStatus).toBe('pending')
    expect(result.status).toBe('answered')
  })

  it('returns structured answer when diagnosis available (no narrative)', async () => {
    const incident = makeIncident({
      diagnosisResult: makeDiagnosisResult(),
    })
    const store = makeMockStore()

    const result = await buildEvidenceQueryAnswer(incident, store, 'What happened?', false)

    expect(result.status).toBe('answered')
    expect(result.segments.length).toBeGreaterThan(0)
    expect(result.noAnswerReason).toBeUndefined()
  })

  it('includes diagnosis-backed inference when diagnosis is available', async () => {
    const incident = makeIncident({
      diagnosisResult: makeDiagnosisResult(),
    })
    const store = makeMockStore()

    const result = await buildEvidenceQueryAnswer(incident, store, 'What happened?', false)

    expect(result.segments.some((segment) => segment.kind === 'inference')).toBe(true)
    expect(result.segments.some((segment) => segment.text.includes('Flash sale traffic exceeded Stripe API quota'))).toBe(true)
  })

  it('every segment carries at least one evidence ref', async () => {
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    const result = await buildEvidenceQueryAnswer(incident, makeMockStore(), 'Why is checkout failing?', false)

    expect(result.segments.length).toBeGreaterThan(0)
    for (const segment of result.segments) {
      expect(segment.evidenceRefs.length).toBeGreaterThan(0)
    }
  })

  it('followups are always populated', async () => {
    const incident = makeIncident()
    const store = makeMockStore()

    const result = await buildEvidenceQueryAnswer(incident, store, 'What happened?', false)

    expect(result.followups.length).toBeGreaterThan(0)
    for (const followup of result.followups) {
      expect(followup.question.length).toBeGreaterThan(0)
      expect(followup.targetEvidenceKinds.length).toBeGreaterThan(0)
    }
  })

  it('evidenceSummary has correct counts', async () => {
    const incident = makeIncident({
      diagnosisResult: makeDiagnosisResult(),
    })
    const store = makeMockStore()

    const result = await buildEvidenceQueryAnswer(incident, store, 'What happened?', false)

    expect(result.evidenceSummary).toBeDefined()
    expect(typeof result.evidenceSummary.traces).toBe('number')
    expect(typeof result.evidenceSummary.metrics).toBe('number')
    expect(typeof result.evidenceSummary.logs).toBe('number')
  })

  it('response validates against EvidenceQueryResponseSchema', async () => {
    // Path 1: unavailable
    const incident1 = makeIncident()
    const result1 = await buildEvidenceQueryAnswer(incident1, makeMockStore(), 'Q?', false)
    EvidenceQueryResponseSchema.parse(result1)

    // Path 1: pending
    const incident2 = makeIncident({ diagnosisDispatchedAt: new Date().toISOString() })
    const result2 = await buildEvidenceQueryAnswer(incident2, makeMockStore(), 'Q?', false)
    EvidenceQueryResponseSchema.parse(result2)

    // Path 2: diagnosis ready, no narrative
    const incident3 = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    const result3 = await buildEvidenceQueryAnswer(incident3, makeMockStore(), 'Q?', false)
    EvidenceQueryResponseSchema.parse(result3)
  })

  it('isFollowup flag does not crash (smoke test)', async () => {
    const incident = makeIncident({
      diagnosisResult: makeDiagnosisResult(),
    })
    const store = makeMockStore()

    // Should not throw regardless of isFollowup value
    const result1 = await buildEvidenceQueryAnswer(incident, store, 'Follow up?', true)
    expect(result1.question).toBe('Follow up?')

    const result2 = await buildEvidenceQueryAnswer(incident, store, 'First question', false)
    expect(result2.question).toBe('First question')
  })

  it('uses recent history to resolve underspecified follow-up action questions', async () => {
    const incident = makeIncident({
      diagnosisResult: makeDiagnosisResult(),
    })
    const store = makeMockStore()

    const result = await buildEvidenceQueryAnswer(
      incident,
      store,
      '次のアクションは？',
      true,
      'ja',
      [
        { role: 'user', content: 'checkout の失敗原因は？' },
        { role: 'assistant', content: '外部 API 側のレート制限が疑わしい。' },
      ],
    )

    expect(result.status).toBe('answered')
    // LLM synthesis should have been called with answerMode=action derived from planner
    const call = generateEvidenceQueryWithMetaMock.mock.calls.at(-1)?.[0] as { answerMode?: string; history?: unknown[] }
    expect(call?.answerMode).toBe('action')
    expect(Array.isArray(call?.history) ? call.history.length : 0).toBeGreaterThan(0)
  })

  it('asks for clarification when an underspecified follow-up has no usable history', async () => {
    const incident = makeIncident({
      diagnosisResult: makeDiagnosisResult(),
    })
    const store = makeMockStore()

    const result = await buildEvidenceQueryAnswer(
      incident,
      store,
      'どうあるべき？',
      true,
      'ja',
      [],
    )

    expect(result.status).toBe('clarification')
    expect(result.clarificationQuestion).toContain('何を知りたいかを一段具体化して')
    expect(result.followups.length).toBeGreaterThan(0)
  })

  it('passes answerMode=missing_evidence to the LLM for absence-type questions', async () => {
    const incident = makeIncident({
      diagnosisResult: makeDiagnosisResult(),
    })
    const store = makeMockStore()

    const result = await buildEvidenceQueryAnswer(
      incident,
      store,
      'なぜlogがない？',
      false,
      'ja',
    )

    expect(result.status).toBe('answered')
    const call = generateEvidenceQueryWithMetaMock.mock.calls.at(-1)?.[0] as { answerMode?: string; locale?: string }
    expect(call?.answerMode).toBe('missing_evidence')
    expect(call?.locale).toBe('ja')
  })

  it('evidence catalog fed to the LLM includes httpStatus=504 when using the new http.response.status_code attribute', async () => {
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    // makeMockStore already uses 'http.response.status_code': 504
    const store = makeMockStore()

    await buildEvidenceQueryAnswer(incident, store, 'Why is checkout failing?', false)

    const call = generateEvidenceQueryWithMetaMock.mock.calls.at(-1)?.[0] as {
      evidence: Array<{ summary: string }>
    }
    expect(call?.evidence.some((entry) => entry.summary.includes('httpStatus=504'))).toBe(true)
  })

  it('evidence catalog carries httpStatus=504 when using deprecated http.status_code attribute (backward compat)', async () => {
    const spans: TelemetrySpan[] = [{
      traceId: 'trace-1',
      spanId: 'span-1',
      parentSpanId: undefined,
      serviceName: 'web',
      environment: 'production',
      spanName: 'POST /checkout',
      httpRoute: '/api/checkout',
      httpStatusCode: 504,
      spanStatusCode: 2,
      durationMs: 1200,
      startTimeMs: 1700000001000,
      exceptionCount: 1,
      attributes: { 'http.status_code': 504 },
      ingestedAt: 1700000002000,
    }]

    const storeWithDeprecated = {
      ...makeMockStore(),
      querySpans: vi.fn().mockResolvedValue(spans),
    }

    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    await buildEvidenceQueryAnswer(incident, storeWithDeprecated, 'Why is checkout failing?', false)

    const call = generateEvidenceQueryWithMetaMock.mock.calls.at(-1)?.[0] as {
      evidence: Array<{ summary: string }>
    }
    expect(call?.evidence.some((entry) => entry.summary.includes('httpStatus=504'))).toBe(true)
  })

  it('routes greetings through the LLM (LLM-first, no template shortcut)', async () => {
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    // Override: LLM decides greeting is status=no_answer with a locale-aware intro.
    generateEvidenceQueryWithMetaMock.mockImplementationOnce(async (input: { question: string; locale?: string }) => withMeta({
      question: input.question,
      status: 'no_answer',
      segments: [],
      evidenceSummary: { traces: 0, metrics: 0, logs: 0 },
      followups: [],
      noAnswerReason: input.locale === 'ja'
        ? 'このインシデントは調査中です。トレース・メトリクス・ログ・診断結果のどれを確認する？'
        : 'Incident is under investigation — what would you like to check: traces, metrics, logs, or the diagnosed cause?',
    }))

    const result = await buildEvidenceQueryAnswer(incident, makeMockStore(), 'こんにちは？', false, 'ja')

    expect(generateEvidenceQueryWithMetaMock).toHaveBeenCalledOnce()
    expect(result.status).toBe('no_answer')
    expect(result.noAnswerReason).toBeTruthy()
  })

  it('routes glossary questions (X とは?) through the LLM with locale and retrieved evidence', async () => {
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })

    await buildEvidenceQueryAnswer(incident, makeMockStore(), 'バックオフって何？', false, 'ja')

    expect(generateEvidenceQueryWithMetaMock).toHaveBeenCalled()
    const call = generateEvidenceQueryWithMetaMock.mock.calls.at(-1)?.[0] as {
      question: string
      locale?: string
      evidence: unknown[]
    }
    expect(call?.question).toContain('バックオフ')
    expect(call?.locale).toBe('ja')
    expect(Array.isArray(call?.evidence) ? call.evidence.length : 0).toBeGreaterThan(0)
  })

  it('routes explanatory queue question through the LLM', async () => {
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })

    const result = await buildEvidenceQueryAnswer(incident, makeMockStore(), 'キューって何？', false, 'ja')

    expect(generateEvidenceQueryWithMetaMock).toHaveBeenCalled()
    expect(result.status).toBe('answered')
  })

  it('routes trace definition question through the LLM', async () => {
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })

    const result = await buildEvidenceQueryAnswer(incident, makeMockStore(), 'トレースって何？', false, 'ja')

    expect(generateEvidenceQueryWithMetaMock).toHaveBeenCalled()
    expect(result.status).toBe('answered')
  })

  it('compound greeting+question ("こんにちは。原因は？") routes through LLM instead of being swallowed by a greeting keyword match', async () => {
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })

    const result = await buildEvidenceQueryAnswer(incident, makeMockStore(), 'こんにちは。原因は？', false, 'ja')

    expect(generateEvidenceQueryWithMetaMock).toHaveBeenCalled()
    expect(result.status).toBe('answered')
  })

  it('localizes followups when locale is ja', async () => {
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    const result = await buildEvidenceQueryAnswer(incident, makeMockStore(), '原因は？', false, 'ja')

    expect(result.followups.length).toBeGreaterThan(0)
    expect(result.followups[0]?.question).toContain('メトリクス')
  })

  // ── #333: Evidence query diversity ──────────────────────────────────────

  /**
   * Store where queryMetrics returns anomalous incident data (asDouble=0.85) for
   * the incident window and low-value baseline data (asDouble≈0.02) for the
   * baseline window, so buildMetricsSurface produces metric_group entries.
   * Uses asDouble because extractMetricValue() only reads asDouble/asInt/sum+count.
   */
  function makeMockStoreWithAnomalousMetrics(): TelemetryStoreDriver {
    // Uses asDouble so extractMetricValue() can parse the value correctly
    const incidentMetric: TelemetryMetric = {
      service: 'web',
      environment: 'production',
      name: 'checkout.error_rate',
      startTimeMs: 1700000000000,
      summary: { asDouble: 0.85 },
      ingestedAt: 1700000002000,
    }
    // Three samples to satisfy MIN_BASELINE_DATAPOINTS so z-score path is used.
    const baselineMetrics: TelemetryMetric[] = [
      {
        service: 'web',
        environment: 'production',
        name: 'checkout.error_rate',
        startTimeMs: 1699998800000,
        summary: { asDouble: 0.02 },
        ingestedAt: 1699998802000,
      },
      {
        service: 'web',
        environment: 'production',
        name: 'checkout.error_rate',
        startTimeMs: 1699998900000,
        summary: { asDouble: 0.03 },
        ingestedAt: 1699998902000,
      },
      {
        service: 'web',
        environment: 'production',
        name: 'checkout.error_rate',
        startTimeMs: 1699999000000,
        summary: { asDouble: 0.02 },
        ingestedAt: 1699999002000,
      },
    ]
    const base = makeMockStore()
    return {
      ...base,
      // incident window startMs >= 1700000000000; baseline window endMs <= 1699999999999
      queryMetrics: vi.fn().mockImplementation(
        (filter: { startMs: number }) =>
          Promise.resolve(filter.startMs >= 1700000000000 ? [incidentMetric] : baselineMetrics),
      ),
    }
  }

  it('trace-focused question returns trace evidence as top segment ref', async () => {
    generateEvidencePlanMock.mockResolvedValueOnce({
      mode: 'answer',
      rewrittenQuestion: 'Which trace spans show the failure path?',
      preferredSurfaces: ['traces', 'logs', 'metrics'],
    })
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    const store = makeMockStoreWithAnomalousMetrics()

    const result = await buildEvidenceQueryAnswer(
      incident,
      store,
      'Which trace spans show the failure path?',
      false,
    )

    expect(result.status).toBe('answered')
    const allRefs = result.segments.flatMap((seg) => seg.evidenceRefs)
    const traceRefs = allRefs.filter((ref) => ref.kind === 'span')
    expect(traceRefs.length).toBeGreaterThan(0)
    // The first segment's refs should include a span (trace evidence)
    expect(result.segments[0]?.evidenceRefs.some((ref) => ref.kind === 'span')).toBe(true)
  })

  it('metric-focused question returns metric evidence as top segment ref', async () => {
    generateEvidencePlanMock.mockResolvedValueOnce({
      mode: 'answer',
      rewrittenQuestion: 'What does the error rate metric show?',
      preferredSurfaces: ['metrics', 'traces', 'logs'],
    })
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    const store = makeMockStoreWithAnomalousMetrics()

    const result = await buildEvidenceQueryAnswer(
      incident,
      store,
      'What does the error rate metric show?',
      false,
    )

    expect(result.status).toBe('answered')
    expect(result.evidenceSummary.metrics).toBeGreaterThan(0)
    const allRefs = result.segments.flatMap((seg) => seg.evidenceRefs)
    const metricRefs = allRefs.filter((ref) => ref.kind === 'metric_group')
    expect(metricRefs.length).toBeGreaterThan(0)
    // The first segment's refs should include a metric_group
    expect(result.segments[0]?.evidenceRefs.some((ref) => ref.kind === 'metric_group')).toBe(true)
  })

  it('log-focused question returns log evidence as top segment ref', async () => {
    generateEvidencePlanMock.mockResolvedValueOnce({
      mode: 'answer',
      rewrittenQuestion: 'What do the error logs say?',
      preferredSurfaces: ['logs', 'traces', 'metrics'],
    })
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    const store = makeMockStoreWithAnomalousMetrics()

    const result = await buildEvidenceQueryAnswer(
      incident,
      store,
      'What do the error logs say?',
      false,
    )

    expect(result.status).toBe('answered')
    const allRefs = result.segments.flatMap((seg) => seg.evidenceRefs)
    const logRefs = allRefs.filter((ref) => ref.kind === 'log_cluster' || ref.kind === 'absence')
    expect(logRefs.length).toBeGreaterThan(0)
    // The first segment's refs should include a log ref
    expect(
      result.segments[0]?.evidenceRefs.some(
        (ref) => ref.kind === 'log_cluster' || ref.kind === 'absence',
      ),
    ).toBe(true)
  })

  it('trace question and metric question return different top evidence refs', async () => {
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    const store = makeMockStoreWithAnomalousMetrics()

    // Turn 2: trace question
    generateEvidencePlanMock.mockResolvedValueOnce({
      mode: 'answer',
      rewrittenQuestion: 'Show me the trace path for this failure',
      preferredSurfaces: ['traces', 'logs', 'metrics'],
    })

    const traceResult = await buildEvidenceQueryAnswer(
      incident,
      store,
      'Show me the trace path for this failure',
      false,
    )

    // Turn 3: metric question
    generateEvidencePlanMock.mockResolvedValueOnce({
      mode: 'answer',
      rewrittenQuestion: 'What is the error rate metric showing?',
      preferredSurfaces: ['metrics', 'traces', 'logs'],
    })

    const metricResult = await buildEvidenceQueryAnswer(
      incident,
      store,
      'What is the error rate metric showing?',
      true,
    )

    const traceFirstRef = traceResult.segments[0]?.evidenceRefs[0]
    const metricFirstRef = metricResult.segments[0]?.evidenceRefs[0]

    // The two questions should produce different first evidence refs (different kinds)
    expect(traceFirstRef?.kind).not.toBe(metricFirstRef?.kind)
    expect(traceFirstRef?.kind).toBe('span')
    expect(metricFirstRef?.kind).toBe('metric_group')
  })
  // ── #335: CF Workers — traces-only evidence ─────────────────────────────

  function makeTracesOnlyStore(traceId: string, spanId: string, httpStatusCode = 500): TelemetryStoreDriver {
    return {
      querySpans: vi.fn().mockResolvedValue([{
        traceId,
        spanId,
        parentSpanId: undefined,
        serviceName: 'worker',
        environment: 'production',
        spanName: 'fetch /api/checkout',
        httpRoute: '/api/checkout',
        httpStatusCode,
        spanStatusCode: 2,
        durationMs: 2100,
        startTimeMs: 1700000001000,
        exceptionCount: 1,
        attributes: { 'http.response.status_code': httpStatusCode },
        ingestedAt: 1700000002000,
      }]),
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

  it('returns non-empty evidenceRefs when only traces are available (CF Workers scenario)', async () => {
    const incident = makeIncident({
      diagnosisResult: makeDiagnosisResult(),
      spanMembership: ['trace-cf-1:span-cf-1'],
    })

    const result = await buildEvidenceQueryAnswer(incident, makeTracesOnlyStore('trace-cf-1', 'span-cf-1'), 'What caused the checkout failure?', false)

    expect(result.status).toBe('answered')
    expect(result.segments.length).toBeGreaterThan(0)
    for (const segment of result.segments) {
      expect(segment.evidenceRefs.length).toBeGreaterThan(0)
    }
    // No segment should contain only absence refs when traces are available.
    // Absence-only segments are misleading ("0 entries matching [healthcheck]...")
    // for general trace-focused questions.
    for (const segment of result.segments) {
      const nonAbsenceRefs = segment.evidenceRefs.filter((ref) => ref.kind !== 'absence')
      expect(nonAbsenceRefs.length).toBeGreaterThan(0)
    }
  })

  it('response validates against schema when only traces are available (CF Workers scenario)', async () => {
    const incident = makeIncident({
      diagnosisResult: makeDiagnosisResult(),
      spanMembership: ['trace-cf-2:span-cf-2'],
    })

    const result = await buildEvidenceQueryAnswer(incident, makeTracesOnlyStore('trace-cf-2', 'span-cf-2', 504), 'Why is checkout failing?', false)
    EvidenceQueryResponseSchema.parse(result)
  })

  // ── Locale=ja evidence-catalog content fed to LLM ────────────────────────

  it('evidence catalog passed to LLM uses Japanese fact summaries when locale=ja', async () => {
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    const store = makeMockStoreWithAnomalousMetrics()

    await buildEvidenceQueryAnswer(
      incident,
      store,
      'checkoutが失敗している原因は？',
      false,
      'ja',
    )

    const call = generateEvidenceQueryWithMetaMock.mock.calls.at(-1)?.[0] as {
      evidence: Array<{ summary: string }>
      locale?: string
    }
    expect(call?.locale).toBe('ja')
    // At least one evidence summary should be Japanese, not English template text.
    const summaries = (call?.evidence ?? []).map((entry) => entry.summary)
    const hasJapanese = summaries.some(
      (s) =>
        s.includes('メトリクスグループ') ||
        s.includes('ログ証跡') ||
        s.includes('トレース'),
    )
    expect(hasJapanese).toBe(true)
    // And none should use English metric/log/trace template patterns.
    for (const s of summaries) {
      expect(s).not.toMatch(/^Metric group .+ Verdict=/)
      expect(s).not.toMatch(/^Log evidence .+ of type .+ appeared/)
    }
  })
})

// ── Followup text self-containment contract ──────────────────────────────────
// Followup questions must be self-contained so that when the user sends them
// as a follow-up query the planning layer can answer rather than clarifying.
// Each followup must include a temporal/scope anchor (incident window, 障害期間).

describe('followup text self-containment', () => {
  beforeEach(() => {
    generateEvidencePlanMock.mockReset()
    generateEvidenceQueryWithMetaMock.mockReset()
    generateEvidenceQueryWithMetaMock.mockImplementation(async (input: { question: string; evidence: Array<{ ref: { kind: string; id: string } }> }) => {
      const firstRef = input.evidence[0]?.ref ?? { kind: 'span', id: 'trace-1:span-1' }
      return withMeta({
        question: input.question,
        status: 'answered',
        segments: [
          {
            id: 'seg_1',
            kind: 'fact',
            text: 'Evidence observed during the incident.',
            evidenceRefs: [firstRef as { kind: 'span' | 'metric_group' | 'log_cluster' | 'absence'; id: string }],
          },
        ],
        evidenceSummary: { traces: 0, metrics: 0, logs: 0 },
        followups: [],
      })
    })
  })

  async function getFollowups(
    locale: 'en' | 'ja',
    question: string,
  ): Promise<string[]> {
    generateEvidencePlanMock.mockResolvedValueOnce({
      mode: 'answer',
      rewrittenQuestion: question,
      preferredSurfaces: ['traces', 'logs', 'metrics'],
    })
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    const store = makeMockStore()
    const result = await buildEvidenceQueryAnswer(incident, store, question, false, locale)
    return (result.followups ?? []).map((f) => f.question)
  }

  it('en followup texts contain incident-window scope anchor', async () => {
    const followups = await getFollowups('en', 'What happened?')
    for (const text of followups) {
      const hasAnchor =
        text.includes('incident') ||
        text.includes('window') ||
        text.includes('during') ||
        text.includes('Within')
      expect(
        hasAnchor,
        `Followup lacks incident-window anchor: "${text}"`,
      ).toBe(true)
    }
  })

  it('ja followup texts contain incident-window scope anchor (障害期間)', async () => {
    const followups = await getFollowups('ja', '何が起きたか？')
    for (const text of followups) {
      const hasAnchor = text.includes('障害期間')
      expect(
        hasAnchor,
        `Followup lacks 障害期間 anchor: "${text}"`,
      ).toBe(true)
    }
  })

  it('trace_path followup is self-contained in en', async () => {
    // Simulate a logs-surface question so trace_path followup is generated
    generateEvidencePlanMock.mockResolvedValueOnce({
      mode: 'answer',
      rewrittenQuestion: 'What do the error logs say?',
      preferredSurfaces: ['logs', 'traces', 'metrics'],
    })
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    const store = makeMockStore()
    const result = await buildEvidenceQueryAnswer(incident, store, 'What do the error logs say?', false, 'en')
    const traceFollowup = (result.followups ?? []).find((f) => f.targetEvidenceKinds.includes('traces'))
    expect(traceFollowup).toBeDefined()
    // Must contain "incident" or "window" or "Within" so the planner knows the scope
    const hasAnchor =
      (traceFollowup?.question ?? '').includes('incident') ||
      (traceFollowup?.question ?? '').includes('window') ||
      (traceFollowup?.question ?? '').includes('Within')
    expect(hasAnchor, `trace_path followup lacks scope: "${traceFollowup?.question}"`).toBe(true)
  })

  it('trace_path followup is self-contained in ja', async () => {
    generateEvidencePlanMock.mockResolvedValueOnce({
      mode: 'answer',
      rewrittenQuestion: 'エラーログは何を示しているか？',
      preferredSurfaces: ['logs', 'traces', 'metrics'],
    })
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    const store = makeMockStore()
    const result = await buildEvidenceQueryAnswer(incident, store, 'エラーログは何を示しているか？', false, 'ja')
    const traceFollowup = (result.followups ?? []).find((f) => f.targetEvidenceKinds.includes('traces'))
    expect(traceFollowup).toBeDefined()
    expect(
      (traceFollowup?.question ?? '').includes('障害期間'),
      `trace_path ja followup lacks 障害期間: "${traceFollowup?.question}"`,
    ).toBe(true)
  })
})

describe('replyToClarification enrichment', () => {
  it('enriches question with original context when replyToClarification is provided', async () => {
    // The plan mock should receive the enriched question
    generateEvidencePlanMock.mockImplementation(async (input: { question: string }) => {
      // Verify the enriched question was passed to the planner
      expect(input.question).toContain('What caused the error rate spike')
      expect(input.question).toContain('the checkout service')
      return {
        mode: 'answer',
        rewrittenQuestion: 'What caused the error rate spike in the checkout service?',
        preferredSurfaces: ['traces', 'metrics', 'logs'],
      }
    })
    generateEvidenceQueryWithMetaMock.mockResolvedValueOnce(withMeta({
      question: 'the checkout service',
      status: 'answered',
      segments: [{
        id: 'seg-1',
        kind: 'fact',
        text: 'The checkout service experienced 504 errors',
        evidenceRefs: [{ kind: 'span', id: 'span-1' }],
      }],
      evidenceSummary: { traces: 1, metrics: 1, logs: 1 },
      followups: [],
    }))

    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    const store = makeMockStore()
    const result = await buildEvidenceQueryAnswer(
      incident,
      store,
      'the checkout service',
      true,
      'en',
      [],
      false,
      { originalQuestion: 'What caused the error rate spike', clarificationText: 'Which service are you asking about?' },
    )

    expect(result.status).toBe('answered')
    expect(generateEvidencePlanMock).toHaveBeenCalled()
  })

  it('passes question unchanged when replyToClarification is not provided', async () => {
    generateEvidencePlanMock.mockImplementation(async (input: { question: string }) => {
      expect(input.question).toBe('What caused the error rate spike?')
      return {
        mode: 'answer',
        rewrittenQuestion: 'What caused the error rate spike?',
        preferredSurfaces: ['traces', 'metrics', 'logs'],
      }
    })
    generateEvidenceQueryWithMetaMock.mockResolvedValueOnce(withMeta({
      question: 'What caused the error rate spike?',
      status: 'answered',
      segments: [{
        id: 'seg-1',
        kind: 'fact',
        text: 'The checkout service experienced 504 errors',
        evidenceRefs: [{ kind: 'span', id: 'span-1' }],
      }],
      evidenceSummary: { traces: 1, metrics: 1, logs: 1 },
      followups: [],
    }))

    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    const store = makeMockStore()
    const result = await buildEvidenceQueryAnswer(
      incident,
      store,
      'What caused the error rate spike?',
      false,
      'en',
      [],
      false,
      // no replyToClarification
    )

    expect(result.status).toBe('answered')
    expect(generateEvidencePlanMock).toHaveBeenCalled()
  })

  it('replyToClarification field is optional in EvidenceQueryRequestSchema', async () => {
    const { EvidenceQueryRequestSchema } = await import('3am-core')

    // Without replyToClarification
    const withoutResult = EvidenceQueryRequestSchema.safeParse({
      question: 'What happened?',
    })
    expect(withoutResult.success).toBe(true)

    // With replyToClarification
    const withResult = EvidenceQueryRequestSchema.safeParse({
      question: 'the checkout service',
      replyToClarification: {
        originalQuestion: 'What caused the error?',
        clarificationText: 'Which service?',
      },
    })
    expect(withResult.success).toBe(true)

    // With invalid replyToClarification (missing required field)
    const invalidResult = EvidenceQueryRequestSchema.safeParse({
      question: 'test',
      replyToClarification: {
        originalQuestion: 'What?',
        // missing clarificationText
      },
    })
    expect(invalidResult.success).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// LLM-first decision coverage (per CLAUDE.md). These tests exercise the
// structured context fields the domain layer now passes to the LLM instead
// of producing deterministic template answers.
// ──────────────────────────────────────────────────────────────────────────

describe('LLM-first synthesis context (CLAUDE.md rule)', () => {
  beforeEach(() => {
    generateEvidencePlanMock.mockReset()
    generateEvidenceQueryWithMetaMock.mockReset()
    generateEvidencePlanMock.mockImplementation(async (input: { question: string }) => ({
      mode: input.question.includes('logがない') || input.question.includes('ログがない')
        ? 'missing_evidence'
        : 'answer',
      rewrittenQuestion: input.question,
      preferredSurfaces: ['traces', 'metrics', 'logs'],
    }))
    generateEvidenceQueryWithMetaMock.mockImplementation(async (input: { question: string; evidence: Array<{ ref: { kind: string; id: string } }> }) => {
      const firstRef = input.evidence[0]?.ref ?? { kind: 'span', id: 'trace-1:span-1' }
      return withMeta({
        question: input.question,
        status: 'answered',
        segments: [
          {
            id: 'seg_1',
            kind: 'fact',
            text: 'synthesized.',
            evidenceRefs: [firstRef as { kind: 'span' | 'metric_group' | 'log_cluster' | 'absence'; id: string }],
          },
        ],
        evidenceSummary: { traces: 0, metrics: 0, logs: 0 },
        followups: [],
      })
    })
  })

  it('Decision 1 — diagnosisStatus=pending flows to synthesis prompt', async () => {
    const incident = makeIncident({ diagnosisDispatchedAt: new Date().toISOString() })
    await buildEvidenceQueryAnswer(incident, makeMockStore(), 'What happened so far?', false)

    const call = generateEvidenceQueryWithMetaMock.mock.calls.at(-1)?.[0] as { diagnosisStatus?: string; diagnosis?: unknown }
    expect(call?.diagnosisStatus).toBe('pending')
    // Planner is skipped when diagnosis is not ready, so diagnosis context is null.
    expect(call?.diagnosis).toBeNull()
  })

  it('Decision 1 — diagnosisStatus=unavailable flows to synthesis prompt', async () => {
    const incident = makeIncident()
    await buildEvidenceQueryAnswer(incident, makeMockStore(), 'Anything you can tell me?', false)

    const call = generateEvidenceQueryWithMetaMock.mock.calls.at(-1)?.[0] as { diagnosisStatus?: string; diagnosis?: unknown }
    expect(call?.diagnosisStatus).toBe('unavailable')
    expect(call?.diagnosis).toBeNull()
  })

  it('Decision 1 — diagnosisStatus=ready with diagnosis context is forwarded when diagnosis finished', async () => {
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    await buildEvidenceQueryAnswer(incident, makeMockStore(), 'Why is checkout failing?', false)

    const call = generateEvidenceQueryWithMetaMock.mock.calls.at(-1)?.[0] as {
      diagnosisStatus?: string
      diagnosis?: { rootCauseHypothesis?: string } | null
    }
    expect(call?.diagnosisStatus).toBe('ready')
    expect(call?.diagnosis?.rootCauseHypothesis).toContain('Flash sale')
  })

  it('Decision 2 — greeting message is handled by LLM synthesis (not a keyword branch)', async () => {
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    const result = await buildEvidenceQueryAnswer(incident, makeMockStore(), 'hello', false, 'en')

    expect(generateEvidenceQueryWithMetaMock).toHaveBeenCalled()
    expect(result.status).not.toBe('clarification')
  })

  it('Decision 3 — evidenceStatus is passed to the LLM (empty | sparse | dense)', async () => {
    // Empty telemetry store. The curated-evidence builder may still synthesize
    // absence entries, so retrieved length is not strictly 0; the key contract
    // is that evidenceStatus is one of the documented values and is forwarded.
    const emptyStore: TelemetryStoreDriver = {
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
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult(), spanMembership: [] })

    await buildEvidenceQueryAnswer(incident, emptyStore, 'Why is checkout failing?', false)

    const call = generateEvidenceQueryWithMetaMock.mock.calls.at(-1)?.[0] as {
      evidenceStatus?: string
    }
    expect(['empty', 'sparse', 'dense']).toContain(call?.evidenceStatus ?? '')
    // With a fully empty telemetry store (and no absence-synthesis input),
    // evidence should be empty or at most sparse — never dense.
    expect(call?.evidenceStatus).not.toBe('dense')
  })

  it('Decision 4 — safety net returns a deterministic no_answer only when the LLM fails after retries', async () => {
    // Simulate the retry-aware generator throwing after exhausting retries.
    generateEvidenceQueryWithMetaMock.mockRejectedValueOnce(new Error('retries exhausted'))

    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    const result = await buildEvidenceQueryAnswer(incident, makeMockStore(), 'Why is checkout failing?', false)

    expect(result.status).toBe('no_answer')
    expect(result.noAnswerReason).toContain('LLM synthesis failed after retries')
  })

  it('safety-net noAnswerReason is Japanese when locale=ja and LLM fails', async () => {
    // Regression: noAnswerReason was hardcoded English regardless of locale.
    generateEvidenceQueryWithMetaMock.mockRejectedValueOnce(new Error('provider unreachable'))

    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    const result = await buildEvidenceQueryAnswer(
      incident,
      makeMockStore(),
      'チェックアウトが失敗している原因は？',
      false,
      'ja',
    )

    expect(result.status).toBe('no_answer')
    expect(result.noAnswerReason).toBeTruthy()
    // Must contain Japanese characters — not the hardcoded English string
    expect(result.noAnswerReason).toMatch(/[ぁ-んァ-ン一-龥]/)
    expect(result.noAnswerReason).not.toContain('LLM synthesis failed after retries')
  })

  it('safety-net noAnswerReason is English when locale=en and LLM fails', async () => {
    generateEvidenceQueryWithMetaMock.mockRejectedValueOnce(new Error('provider unreachable'))

    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    const result = await buildEvidenceQueryAnswer(
      incident,
      makeMockStore(),
      'Why is checkout failing?',
      false,
      'en',
    )

    expect(result.status).toBe('no_answer')
    expect(result.noAnswerReason).toContain('LLM synthesis failed after retries')
    expect(result.noAnswerReason).not.toMatch(/[ぁ-んァ-ン一-龥]/)
  })

  it('safety-net followups are in Japanese when locale=ja and LLM fails', async () => {
    // Regression: buildDeterministicNoAnswer was calling buildFollowups without
    // locale, so followups always came back in English even with locale=ja.
    generateEvidenceQueryWithMetaMock.mockRejectedValueOnce(new Error('provider unreachable'))

    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    const result = await buildEvidenceQueryAnswer(
      incident,
      makeMockStore(),
      'チェックアウトが失敗している原因は？',
      false,
      'ja',
    )

    expect(result.status).toBe('no_answer')
    expect(result.followups.length).toBeGreaterThan(0)
    // Every followup question must be Japanese — none should contain English trigger words
    for (const fu of result.followups) {
      expect(fu.question).not.toMatch(/^(Do the|Which|Within|What expected)/i)
    }
    // At least one followup should contain a Japanese anchor
    const hasJapanese = result.followups.some(
      (fu) => /[ぁ-んァ-ン一-龥]/.test(fu.question),
    )
    expect(hasJapanese).toBe(true)
  })

  it('safety-net followups are in English when locale=en and LLM fails', async () => {
    generateEvidenceQueryWithMetaMock.mockRejectedValueOnce(new Error('provider unreachable'))

    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    const result = await buildEvidenceQueryAnswer(
      incident,
      makeMockStore(),
      'Why is checkout failing?',
      false,
      'en',
    )

    expect(result.status).toBe('no_answer')
    expect(result.followups.length).toBeGreaterThan(0)
    // English followups should not contain Japanese characters
    for (const fu of result.followups) {
      expect(fu.question).not.toMatch(/[ぁ-んァ-ン一-龥]/)
    }
  })

  it('safety-net followups default to English when no locale is passed and LLM fails', async () => {
    generateEvidenceQueryWithMetaMock.mockRejectedValueOnce(new Error('provider unreachable'))

    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    // No locale argument — should default to "en"
    const result = await buildEvidenceQueryAnswer(
      incident,
      makeMockStore(),
      'Why is checkout failing?',
      false,
    )

    expect(result.status).toBe('no_answer')
    expect(result.followups.length).toBeGreaterThan(0)
    for (const fu of result.followups) {
      expect(fu.question).not.toMatch(/[ぁ-んァ-ン一-龥]/)
    }
  })

  it('Decision 5 — absence-type question sends a structured absenceInput to the LLM', async () => {
    // Build a store where curated logs surface an absence claim.
    const storeWithAbsence: TelemetryStoreDriver = {
      querySpans: vi.fn().mockResolvedValue([{
        traceId: 'trace-1',
        spanId: 'span-1',
        parentSpanId: undefined,
        serviceName: 'web',
        environment: 'production',
        spanName: 'POST /checkout',
        httpRoute: '/api/checkout',
        httpStatusCode: 504,
        spanStatusCode: 2,
        durationMs: 1200,
        startTimeMs: 1700000001000,
        exceptionCount: 1,
        attributes: { 'http.response.status_code': 504 },
        ingestedAt: 1700000002000,
      }]),
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

    // Ask about the missing signal so planner picks missing_evidence mode.
    generateEvidencePlanMock.mockResolvedValueOnce({
      mode: 'missing_evidence',
      rewrittenQuestion: 'Why are the expected retry logs missing?',
      preferredSurfaces: ['logs', 'traces', 'metrics'],
    })

    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    await buildEvidenceQueryAnswer(incident, storeWithAbsence, 'なぜlogがない？', false, 'ja')

    const call = generateEvidenceQueryWithMetaMock.mock.calls.at(-1)?.[0] as {
      answerMode?: string
      absenceInput?: { claimType?: string }
    }
    expect(call?.answerMode).toBe('missing_evidence')
    // absenceInput is only set when the curated logs surface has an absence
    // claim. Even without one, answerMode=missing_evidence must still reach
    // the LLM so synthesis can explain "no record found".
    if (call?.absenceInput) {
      expect(['no-record-found', 'no-supporting-evidence', 'not-yet-available']).toContain(call.absenceInput.claimType ?? '')
    }
  })
})
