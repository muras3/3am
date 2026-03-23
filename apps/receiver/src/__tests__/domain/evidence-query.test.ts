/**
 * evidence-query.test.ts — Domain tests for POST /api/incidents/:id/evidence/query.
 *
 * Tests deterministic paths (1 and 2) of buildEvidenceQueryAnswer.
 * Path 3 (LLM) is not tested here — Anthropic SDK is not mocked.
 */

import { describe, expect, it, vi } from 'vitest'
import type { TelemetryStoreDriver } from '../../telemetry/interface.js'
import type { Incident } from '../../storage/interface.js'
import type { IncidentPacket, DiagnosisResult } from '@3amoncall/core'
import { EvidenceQueryResponseSchema } from '@3amoncall/core/schemas/curated-evidence'

// Mock the Anthropic SDK so Path 3 never calls a real API
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = {
      create: vi.fn().mockRejectedValue(new Error('LLM not available in test')),
    }
  },
}))

import { buildEvidenceQueryAnswer } from '../../domain/evidence-query.js'

// ── Fixture factories ───────────────────────────────────────────────────

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
  it('returns noAnswerReason when diagnosis is unavailable', async () => {
    const incident = makeIncident()
    const store = makeMockStore()

    const result = await buildEvidenceQueryAnswer(incident, store, 'What happened?', false)

    expect(result.noAnswerReason).toBeTruthy()
    expect(result.noAnswerReason).toContain('No diagnosis has been triggered')
  })

  it('returns noAnswerReason when diagnosis is pending', async () => {
    const incident = makeIncident({
      diagnosisDispatchedAt: '2024-01-01T00:02:00Z',
    })
    const store = makeMockStore()

    const result = await buildEvidenceQueryAnswer(incident, store, 'What happened?', false)

    expect(result.noAnswerReason).toBeTruthy()
    expect(result.noAnswerReason).toContain('Diagnosis is still running')
  })

  it('returns structured answer when diagnosis available (no narrative)', async () => {
    const incident = makeIncident({
      diagnosisResult: makeDiagnosisResult(),
    })
    const store = makeMockStore()

    const result = await buildEvidenceQueryAnswer(incident, store, 'What happened?', false)

    expect(result.answer.length).toBeGreaterThan(0)
    expect(result.noAnswerReason).toBeUndefined()
  })

  it('answer includes what_happened summary when diagnosis available', async () => {
    const incident = makeIncident({
      diagnosisResult: makeDiagnosisResult(),
    })
    const store = makeMockStore()

    const result = await buildEvidenceQueryAnswer(incident, store, 'What happened?', false)

    expect(result.answer).toContain('Stripe API rate limited')
  })

  it('confidence is unavailable/0 when no diagnosis', async () => {
    const incident = makeIncident()
    const store = makeMockStore()

    const result = await buildEvidenceQueryAnswer(incident, store, 'What happened?', false)

    expect(result.confidence.label).toBe('unavailable')
    expect(result.confidence.value).toBe(0)
  })

  it('confidence is medium/0.5 when diagnosis without narrative', async () => {
    const incident = makeIncident({
      diagnosisResult: makeDiagnosisResult(),
    })
    const store = makeMockStore()

    const result = await buildEvidenceQueryAnswer(incident, store, 'What happened?', false)

    expect(result.confidence.label).toBe('medium')
    expect(result.confidence.value).toBe(0.5)
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
    EvidenceQueryResponseSchema.strict().parse(result1)

    // Path 1: pending
    const incident2 = makeIncident({ diagnosisDispatchedAt: '2024-01-01T00:02:00Z' })
    const result2 = await buildEvidenceQueryAnswer(incident2, makeMockStore(), 'Q?', false)
    EvidenceQueryResponseSchema.strict().parse(result2)

    // Path 2: diagnosis ready, no narrative
    const incident3 = makeIncident({ diagnosisResult: makeDiagnosisResult() })
    const result3 = await buildEvidenceQueryAnswer(incident3, makeMockStore(), 'Q?', false)
    EvidenceQueryResponseSchema.strict().parse(result3)
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
})
