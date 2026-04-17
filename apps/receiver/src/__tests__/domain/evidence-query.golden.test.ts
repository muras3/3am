import { describe, expect, it, vi } from 'vitest'
import type { DiagnosisResult, IncidentPacket } from '3am-core'
import type { Incident } from '../../storage/interface.js'
import type { TelemetryLog, TelemetryMetric, TelemetrySpan, TelemetryStoreDriver } from '../../telemetry/interface.js'

vi.mock('3am-diagnosis', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    generateEvidencePlan: vi.fn().mockRejectedValue(new Error('LLM not available in golden test')),
    // Retry-aware generator also rejects so the domain falls through to the
    // single safety-net no-answer. This documents what an operator sees when
    // the LLM is unreachable in production.
    generateEvidenceQueryWithMeta: vi.fn().mockRejectedValue(new Error('LLM not available in golden test')),
  }
})

import { buildEvidenceQueryAnswer } from '../../domain/evidence-query.js'

function makeGoldenStore(): TelemetryStoreDriver {
  const spans: TelemetrySpan[] = [
    {
      traceId: 'trace-1',
      spanId: 'checkout-001',
      parentSpanId: undefined,
      serviceName: 'web',
      environment: 'production',
      spanName: 'POST /checkout',
      httpRoute: '/checkout',
      httpStatusCode: 500,
      spanStatusCode: 2,
      durationMs: 2340,
      startTimeMs: 1700000001000,
      exceptionCount: 1,
      attributes: { 'http.response.status_code': 500 },
      ingestedAt: 1700000002000,
    },
    {
      traceId: 'trace-1',
      spanId: 'stripe-charge-001',
      parentSpanId: 'checkout-001',
      serviceName: 'web',
      environment: 'production',
      spanName: 'StripeClient.charge',
      httpRoute: '/checkout',
      httpStatusCode: 429,
      spanStatusCode: 2,
      durationMs: 1990,
      startTimeMs: 1700000001100,
      exceptionCount: 1,
      attributes: { 'http.response.status_code': 429 },
      ingestedAt: 1700000002000,
    },
  ]

  const incidentMetrics: TelemetryMetric[] = [
    {
      service: 'web',
      environment: 'production',
      name: 'order_requests_total',
      startTimeMs: 1700000000000,
      summary: { asInt: 492 },
      ingestedAt: 1700000002000,
    },
    {
      service: 'web',
      environment: 'production',
      name: 'checkout.error_rate',
      startTimeMs: 1700000000000,
      summary: { asDouble: 0.68 },
      ingestedAt: 1700000002000,
    },
    {
      service: 'web',
      environment: 'production',
      name: 'order_requests_total',
      startTimeMs: 1700000001000,
      summary: { asInt: 501 },
      ingestedAt: 1700000003000,
    },
    {
      service: 'web',
      environment: 'production',
      name: 'checkout.error_rate',
      startTimeMs: 1700000001000,
      summary: { asDouble: 0.71 },
      ingestedAt: 1700000002000,
    },
  ]

  const baselineMetrics: TelemetryMetric[] = [
    {
      service: 'web',
      environment: 'production',
      name: 'order_requests_total',
      startTimeMs: 1699999898000,
      summary: { asInt: 39 },
      ingestedAt: 1700000001000,
    },
    {
      service: 'web',
      environment: 'production',
      name: 'checkout.error_rate',
      startTimeMs: 1699999898000,
      summary: { asDouble: 0.01 },
      ingestedAt: 1700000001000,
    },
    {
      service: 'web',
      environment: 'production',
      name: 'order_requests_total',
      startTimeMs: 1699999899000,
      summary: { asInt: 41 },
      ingestedAt: 1700000001000,
    },
    {
      service: 'web',
      environment: 'production',
      name: 'checkout.error_rate',
      startTimeMs: 1699999899000,
      summary: { asDouble: 0.015 },
      ingestedAt: 1700000001000,
    },
    {
      service: 'web',
      environment: 'production',
      name: 'order_requests_total',
      startTimeMs: 1699999900000,
      summary: { asInt: 37 },
      ingestedAt: 1700000001000,
    },
    {
      service: 'web',
      environment: 'production',
      name: 'checkout.error_rate',
      startTimeMs: 1699999900000,
      summary: { asDouble: 0.012 },
      ingestedAt: 1700000001000,
    },
  ]

  const logs: TelemetryLog[] = [
    {
      service: 'web',
      environment: 'production',
      timestamp: '2024-01-01T00:01:00Z',
      startTimeMs: 1700000000000,
      severity: 'ERROR',
      severityNumber: 17,
      body: 'Stripe 429 responses surged on checkout',
      bodyHash: 'stripe-429',
      attributes: {},
      traceId: 'trace-1',
      spanId: 'stripe-charge-001',
      ingestedAt: 1700000002000,
    },
    {
      service: 'web',
      environment: 'production',
      timestamp: '2024-01-01T00:01:01Z',
      startTimeMs: 1700000001000,
      severity: 'ERROR',
      severityNumber: 17,
      body: 'retry exhausted after stripe rate limit',
      bodyHash: 'stripe-retry',
      attributes: {},
      traceId: 'trace-1',
      spanId: 'checkout-001',
      ingestedAt: 1700000002000,
    },
  ]

  return {
    querySpans: vi.fn().mockResolvedValue(spans),
    queryMetrics: vi.fn().mockImplementation(async (filter: { endMs: number }) => {
      return filter.endMs < 1700000000000 ? baselineMetrics : incidentMetrics
    }),
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

function makeGoldenIncident(): Incident {
  const packet: IncidentPacket = {
    schemaVersion: 'incident-packet/v1alpha1',
    packetId: 'pkt-inc-000006',
    incidentId: 'inc_000006',
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
      affectedRoutes: ['/checkout'],
      affectedDependencies: ['stripe'],
    },
    triggerSignals: [],
    evidence: {
      changedMetrics: [
        {
          name: 'order_requests_total',
          service: 'web',
          environment: 'production',
          startTimeMs: 1700000000000,
          summary: { asInt: 492 },
        },
      ],
      representativeTraces: [
        { traceId: 'trace-1', spanId: 'checkout-001', serviceName: 'web', durationMs: 2340, spanStatusCode: 2 },
      ],
      relevantLogs: [
        {
          timestamp: '2024-01-01T00:01:00Z',
          service: 'web',
          environment: 'production',
          startTimeMs: 1700000000000,
          severity: 'ERROR',
          body: 'Stripe 429 responses surged on checkout',
          attributes: {},
        },
      ],
      platformEvents: [],
    },
    pointers: {
      traceRefs: [],
      logRefs: [],
      metricRefs: [],
      platformLogRefs: [],
    },
  }

  const diagnosisResult: DiagnosisResult = {
    summary: {
      what_happened: 'Checkout failures increased after Stripe returned 429s.',
      root_cause_hypothesis: 'Stripe rate limiting and retry amplification caused the checkout failures.',
    },
    recommendation: {
      immediate_action: 'Reduce Stripe call pressure and disable aggressive retries.',
      action_rationale_short: 'Stops quota exhaustion.',
      do_not: 'Do not raise downstream timeouts.',
    },
    reasoning: {
      causal_chain: [
        { type: 'external', title: 'Stripe 429 surge', detail: 'Quota exhausted' },
        { type: 'system', title: 'Retry amplification', detail: 'Retries increased request pressure' },
      ],
    },
    confidence: {
      confidence_assessment: 'high',
      uncertainty: 'Stripe internal quota changes are not visible',
    },
    operator_guidance: {
      watch_items: [],
      operator_checks: ['Check Stripe dashboard'],
    },
    metadata: {
      model: 'test-model',
      created_at: '2024-01-01T00:10:00Z',
      incident_id: 'inc_000006',
      packet_id: 'pkt-inc-000006',
      prompt_version: 'v5',
    },
  }

  return {
    incidentId: 'inc_000006',
    status: 'open',
    openedAt: '2024-01-01T00:00:00Z',
    lastActivityAt: '2024-01-01T00:00:00Z',
    packet,
    diagnosisResult,
    telemetryScope: {
      windowStartMs: 1700000000000,
      windowEndMs: 1700000300000,
      detectTimeMs: 1700000060000,
      environment: 'production',
      memberServices: ['web'],
      dependencyServices: ['stripe'],
    },
    spanMembership: ['trace-1:checkout-001', 'trace-1:stripe-charge-001'],
    anomalousSignals: [
      { signal: 'http_429', firstSeenAt: '2024-01-01T00:01:00Z', entity: 'web', spanId: 'stripe-charge-001' },
    ],
    platformEvents: [],
  }
}

describe('evidence query golden responses', () => {
  it('keeps the inc_000006 follow-up answers stable', async () => {
    const store = makeGoldenStore()
    const incident = makeGoldenIncident()
    const questions = ['原因は？', 'メトリクスに問題はあるか？', '根本原因は？', 'こんにちは？'] as const

    const responses = []
    for (const question of questions) {
      responses.push(await buildEvidenceQueryAnswer(incident, store, question, false, 'ja'))
    }

    expect(responses).toMatchSnapshot()
  })
})
