/**
 * evidence-query.test.ts — Domain tests for POST /api/incidents/:id/evidence/query.
 *
 * Tests deterministic paths (1 and 2) of buildEvidenceQueryAnswer.
 * Path 3 (LLM) is not tested here — Anthropic SDK is not mocked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TelemetryLog, TelemetryMetric, TelemetrySpan, TelemetryStoreDriver } from '../../telemetry/interface.js'
import type { Incident } from '../../storage/interface.js'
import type { IncidentPacket, DiagnosisResult } from '3am-core'
import { EvidenceQueryResponseSchema } from '3am-core/schemas/curated-evidence'
import * as diagnosis from '3am-diagnosis'
const { generateEvidencePlanMock, generateEvidenceQueryMock } = vi.hoisted(() => ({
  generateEvidencePlanMock: vi.fn(),
  generateEvidenceQueryMock: vi.fn(),
}))
vi.mock('3am-diagnosis', async () => {
  const actual = await vi.importActual('3am-diagnosis')
  return {
    ...actual,
    generateEvidencePlan: generateEvidencePlanMock,
    generateEvidenceQuery: generateEvidenceQueryMock,
  }
})

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
    generateEvidenceQueryMock.mockReset()
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
    generateEvidenceQueryMock.mockRejectedValue(new Error('LLM not available in test'))
  })

  it('returns noAnswerReason when diagnosis is unavailable', async () => {
    const incident = makeIncident()
    const store = makeMockStore()

    const result = await buildEvidenceQueryAnswer(incident, store, 'What happened?', false)

    expect(result.status).toBe('no_answer')
    expect(result.noAnswerReason).toBeTruthy()
    expect(result.noAnswerReason).toContain('No diagnosis has been triggered')
  })

  it('returns noAnswerReason when diagnosis is pending', async () => {
    const incident = makeIncident({
      diagnosisDispatchedAt: new Date().toISOString(),
    })
    const store = makeMockStore()

    const result = await buildEvidenceQueryAnswer(incident, store, 'What happened?', false)

    expect(result.status).toBe('no_answer')
    expect(result.noAnswerReason).toBeTruthy()
    expect(result.noAnswerReason).toContain('Diagnosis is still running')
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
    expect(result.segments.some((segment) => segment.text.includes('最小アクション'))).toBe(true)
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

  // ── Phase 1: clarification question included in history serialization ────
  // (This is a console-side behavior, tested via integration / QAFrame tests)

  // ── Phase 3: Numbered reference resolution ─────────────────────────────

  it('resolves numbered reply "1" against clarification options', async () => {
    generateEvidencePlanMock.mockResolvedValueOnce({
      mode: 'answer',
      rewrittenQuestion: 'Show me the trace path for the first failure',
      preferredSurfaces: ['traces', 'logs', 'metrics'],
    })
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    const store = makeMockStore()

    const result = await buildEvidenceQueryAnswer(
      incident,
      store,
      '1',
      true,
      'en',
      [],
      false,
      {
        originalQuestion: 'What went wrong?',
        clarificationText: '1. The trace path for the first failure\n2. The metric anomaly during the incident',
      },
    )

    // Should combine the original question with the resolved option
    expect(result.status).toBe('answered')
    expect(result.segments.length).toBeGreaterThan(0)
  })

  it('resolves numbered reply "1と2" in Japanese', async () => {
    generateEvidencePlanMock.mockResolvedValueOnce({
      mode: 'answer',
      rewrittenQuestion: 'Show traces and metrics',
      preferredSurfaces: ['traces', 'metrics', 'logs'],
    })
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })

    const result = await buildEvidenceQueryAnswer(
      incident,
      makeMockStore(),
      '1と2',
      true,
      'ja',
      [],
      false,
      {
        originalQuestion: '何が問題？',
        clarificationText: '1. トレースの失敗経路\n2. メトリクスの異常',
      },
    )

    expect(result.status).toBe('answered')
  })

  it('passes through free-text reply to clarification with original question context', async () => {
    generateEvidencePlanMock.mockResolvedValueOnce({
      mode: 'answer',
      rewrittenQuestion: 'What went wrong with the trace latency?',
      preferredSurfaces: ['traces', 'logs', 'metrics'],
    })
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })

    const result = await buildEvidenceQueryAnswer(
      incident,
      makeMockStore(),
      'I want to see the latency details',
      true,
      'en',
      [],
      false,
      {
        originalQuestion: 'What went wrong?',
        clarificationText: 'Could you be more specific about what aspect you want to explore?',
      },
    )

    expect(result.status).toBe('answered')
  })

  // ── Phase 4: Meta-speech / frustration detection ───────────────────────

  it('returns meta-speech response for frustration expressions (en)', async () => {
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })

    const result = await buildEvidenceQueryAnswer(
      incident,
      makeMockStore(),
      'just answer me already',
      false,
      'en',
    )

    expect(result.status).toBe('no_answer')
    expect(result.noAnswerReason).toContain('rephrase')
  })

  it('returns meta-speech response for frustration expressions (ja)', async () => {
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })

    const result = await buildEvidenceQueryAnswer(
      incident,
      makeMockStore(),
      'いかれてる',
      false,
      'ja',
    )

    expect(result.status).toBe('no_answer')
    expect(result.noAnswerReason).toContain('質問を別の言い方')
  })

  it('frustration during clarification falls back to original question best-effort', async () => {
    generateEvidencePlanMock.mockResolvedValueOnce({
      mode: 'answer',
      rewrittenQuestion: 'What went wrong?',
      preferredSurfaces: ['traces', 'metrics', 'logs'],
    })
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })

    const result = await buildEvidenceQueryAnswer(
      incident,
      makeMockStore(),
      '答えろ',
      true,
      'ja',
      [],
      false,
      {
        originalQuestion: '何が起きた？',
        clarificationText: '何を知りたいかを一段具体化して。',
      },
    )

    // Should attempt to answer the original question instead of showing frustration message
    expect(result.status).toBe('answered')
    expect(result.segments.length).toBeGreaterThan(0)
  })

  // ── Phase 5: Clarification escape after 2 consecutive clarifications ───

  it('forces best-effort answer when clarificationChainLength >= 2', async () => {
    // The planner would normally return clarification, but should be forced to answer
    generateEvidencePlanMock.mockResolvedValueOnce({
      mode: 'clarification',
      rewrittenQuestion: 'Clarify again.',
      preferredSurfaces: ['traces'],
      clarificationQuestion: 'もう一回聞くよ',
    })
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })

    const result = await buildEvidenceQueryAnswer(
      incident,
      makeMockStore(),
      'もっと具体的に',
      true,
      'ja',
      [],
      false,
      undefined,
      2, // clarificationChainLength >= 2 forces best-effort
    )

    // Should NOT return clarification since chain is too long
    expect(result.status).not.toBe('clarification')
    expect(result.segments.length).toBeGreaterThan(0)
  })

  it('allows clarification when clarificationChainLength < 2', async () => {
    generateEvidencePlanMock.mockResolvedValueOnce({
      mode: 'clarification',
      rewrittenQuestion: 'Clarify.',
      preferredSurfaces: ['traces'],
      clarificationQuestion: '何を知りたいかを一段具体化して。',
    })
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })

    const result = await buildEvidenceQueryAnswer(
      incident,
      makeMockStore(),
      'どうあるべき？',
      true,
      'ja',
      [],
      false,
      undefined,
      1, // Still under the threshold
    )

    expect(result.status).toBe('clarification')
    expect(result.clarificationQuestion).toBeDefined()
  })

  // ── Schema backward compatibility ─────────────────────────────────────

  it('old clients without replyToClarification still work (backward compat)', async () => {
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    const store = makeMockStore()

    // Simulate old client: no replyToClarification, no clarificationChainLength
    const result = await buildEvidenceQueryAnswer(
      incident,
      store,
      'What happened?',
      false,
      'en',
      [],
      false,
      // no replyToClarification
      // no clarificationChainLength
    )

    expect(result.status).toBe('answered')
    expect(result.segments.length).toBeGreaterThan(0)
  })

  it('answers missing-log questions without collapsing back to the generic cause template', async () => {
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
    expect(result.segments.some((segment) => segment.text.includes('失敗ログ'))).toBe(true)
    expect(result.segments.some((segment) => segment.text.includes('収集経路'))).toBe(true)
  })

  it('span summary includes httpStatus when using new stable attribute http.response.status_code', async () => {
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    // makeMockStore already uses 'http.response.status_code': 504
    const store = makeMockStore()

    const result = await buildEvidenceQueryAnswer(incident, store, 'Why is checkout failing?', false)

    const spanSegment = result.segments.find(
      (seg) => seg.kind === 'fact' && seg.text.includes('httpStatus=504'),
    )
    expect(spanSegment).toBeDefined()
  })

  it('span summary includes httpStatus when using deprecated attribute http.status_code (backward compat)', async () => {
    // Override the store to return a span with the deprecated attribute form
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
    const result = await buildEvidenceQueryAnswer(incident, storeWithDeprecated, 'Why is checkout failing?', false)

    const spanSegment = result.segments.find(
      (seg) => seg.kind === 'fact' && seg.text.includes('httpStatus=504'),
    )
    expect(spanSegment).toBeDefined()
  })

  it('returns concise no_answer for greetings and off-topic prompts', async () => {
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    const generateEvidenceQuerySpy = vi.spyOn(diagnosis, 'generateEvidenceQuery')

    const result = await buildEvidenceQueryAnswer(incident, makeMockStore(), 'こんにちは？', false, 'ja')

    expect(result.status).toBe('no_answer')
    expect(result.segments).toEqual([])
    expect(result.noAnswerReason).toContain('このインシデントについて')
    expect(generateEvidenceQuerySpy).not.toHaveBeenCalled()
  })

  it('answers incident-context glossary questions for backoff', async () => {
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    const generateEvidenceQuerySpy = vi.spyOn(diagnosis, 'generateEvidenceQuery')

    const result = await buildEvidenceQueryAnswer(incident, makeMockStore(), 'バックオフって何？', false, 'ja')

    expect(result.status).toBe('answered')
    expect(result.segments[0]?.text).toContain('バックオフは')
    expect(result.segments.some((segment) => segment.text.includes('このインシデントでは'))).toBe(true)
    expect(result.segments.every((segment) => segment.evidenceRefs.length > 0)).toBe(true)
    expect(generateEvidenceQuerySpy).not.toHaveBeenCalled()
  })

  it('answers incident-context glossary questions for queue', async () => {
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    const result = await buildEvidenceQueryAnswer(incident, makeMockStore(), 'キューって何？', false, 'ja')

    expect(result.status).toBe('answered')
    expect(result.segments[0]?.text).toContain('キューは')
    expect(result.segments.some((segment) => segment.text.includes('このインシデントでは'))).toBe(true)
  })

  it('answers incident-context glossary questions for worker pool via registry', async () => {
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    const result = await buildEvidenceQueryAnswer(incident, makeMockStore(), 'ワーカープールってなんですか？', false, 'ja')

    expect(result.status).toBe('answered')
    expect(result.segments[0]?.text).toContain('ワーカープールは')
    expect(result.segments.some((segment) => segment.text.includes('このインシデントでは'))).toBe(true)
  })

  it('answers general explanations for trace without no-answer fallback', async () => {
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    const result = await buildEvidenceQueryAnswer(incident, makeMockStore(), 'トレースって何？', false, 'ja')

    expect(result.status).toBe('answered')
    expect(result.segments[0]?.text).toContain('トレースは')
    expect(result.segments.some((segment) => segment.text.includes('このインシデントでは'))).toBe(true)
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

  // ── Locale=ja fact segment output ────────────────────────────────────────

  it('fact segments use Japanese strings when locale=ja', async () => {
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    const store = makeMockStoreWithAnomalousMetrics()

    const result = await buildEvidenceQueryAnswer(
      incident,
      store,
      'checkoutが失敗している原因は？',
      false,
      'ja',
    )

    expect(result.status).toBe('answered')

    const factSegments = result.segments.filter((seg) => seg.kind === 'fact')
    expect(factSegments.length).toBeGreaterThan(0)

    // At least one fact segment should contain Japanese metric or log text
    const hasJapaneseFact = factSegments.some(
      (seg) =>
        seg.text.includes('メトリクスグループ') ||
        seg.text.includes('ログ証跡') ||
        seg.text.includes('トレース'),
    )
    expect(hasJapaneseFact).toBe(true)

    // None of the fact segments should contain English-only metric/log patterns
    for (const seg of factSegments) {
      // English metric pattern: "Metric group ... Verdict=..."
      expect(seg.text).not.toMatch(/^Metric group .+ Verdict=/)
      // English log pattern: "Log evidence ... of type ... appeared"
      expect(seg.text).not.toMatch(/^Log evidence .+ of type .+ appeared/)
    }
  })

  it('no fact segment contains English metric or log template strings when locale=ja', async () => {
    const incident = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    const store = makeMockStoreWithAnomalousMetrics()

    const result = await buildEvidenceQueryAnswer(
      incident,
      store,
      'checkoutが失敗している原因は？',
      false,
      'ja',
    )

    expect(result.status).toBe('answered')

    const factSegments = result.segments.filter((seg) => seg.kind === 'fact')
    for (const seg of factSegments) {
      // Must not use English metric fact pattern
      expect(seg.text).not.toMatch(/Metric group .+ indicates .+ Verdict=/)
      // Must not use English log fact pattern
      expect(seg.text).not.toMatch(/Log evidence .+ of type .+ appeared \d+ times/)
      // Must not use English trace fact pattern
      expect(seg.text).not.toMatch(/Trace .+ span .+ returned httpStatus=/)
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
    generateEvidenceQueryMock.mockReset()
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
