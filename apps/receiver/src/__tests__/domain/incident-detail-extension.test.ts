/**
 * Tests for incident-detail-extension.ts — builds IncidentDetailExtension.
 *
 * Uses MemoryTelemetryAdapter as the TelemetryStoreDriver implementation.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryTelemetryAdapter } from '../../telemetry/adapters/memory.js'
import { buildIncidentDetailExtension } from '../../domain/incident-detail-extension.js'
import type { TelemetrySpan, TelemetryMetric, TelemetryLog } from '../../telemetry/interface.js'
import type { Incident, TelemetryScope, AnomalousSignal } from '../../storage/interface.js'
import type { IncidentPacket, DiagnosisResult } from '@3amoncall/core'

// ── Test helpers ─────────────────────────────────────────────────────────

const BASE_TIME_MS = 1741392000000 // 2025-03-07T16:00:00Z
const BASE_ISO = new Date(BASE_TIME_MS).toISOString()

function makeScope(overrides: Partial<TelemetryScope> = {}): TelemetryScope {
  return {
    windowStartMs: BASE_TIME_MS,
    windowEndMs: BASE_TIME_MS + 60_000,
    detectTimeMs: BASE_TIME_MS,
    environment: 'production',
    memberServices: ['web'],
    dependencyServices: [],
    ...overrides,
  }
}

function makePacket(overrides: Partial<IncidentPacket> = {}): IncidentPacket {
  return {
    schemaVersion: 'incident-packet/v1alpha1',
    packetId: 'pkt_001',
    incidentId: 'inc_001',
    openedAt: BASE_ISO,
    window: {
      start: BASE_ISO,
      detect: new Date(BASE_TIME_MS + 5000).toISOString(),
      end: new Date(BASE_TIME_MS + 60_000).toISOString(),
    },
    scope: {
      environment: 'production',
      primaryService: 'web',
      affectedServices: ['web', 'payment-service'],
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
    ...overrides,
  }
}

function makeDiagnosisResult(overrides: Partial<DiagnosisResult> = {}): DiagnosisResult {
  return {
    summary: {
      what_happened: 'Stripe API returned 429 rate limit errors',
      root_cause_hypothesis: 'Flash sale caused burst of payment requests',
    },
    recommendation: {
      immediate_action: 'Enable exponential backoff on Stripe calls',
      action_rationale_short: 'Reduce pressure on rate-limited API',
      do_not: ['Do not disable Stripe integration'],
    },
    reasoning: {
      causal_chain: [
        { type: 'external', title: 'Flash sale traffic', detail: 'Traffic spike' },
      ],
    },
    operator_guidance: {
      investigation_steps: [],
      escalation_criteria: [],
    },
    confidence: {
      level: 'high',
      reasoning: 'Clear pattern in traces',
    },
    metadata: {
      model: 'claude-sonnet-4-20250514',
      prompt_version: 'v5',
      created_at: new Date(BASE_TIME_MS + 120_000).toISOString(),
      packet_id: 'pkt_001',
      duration_ms: 5000,
    },
    ...overrides,
  } as DiagnosisResult
}

function makeIncident(overrides: Partial<Incident> = {}): Incident {
  return {
    incidentId: 'inc_001',
    status: 'open',
    openedAt: BASE_ISO,
    lastActivityAt: BASE_ISO,
    packet: makePacket(),
    telemetryScope: makeScope(),
    spanMembership: [],
    anomalousSignals: [],
    platformEvents: [],
    ...overrides,
  }
}

function makeSpan(overrides: Partial<TelemetrySpan> = {}): TelemetrySpan {
  return {
    traceId: 'trace001',
    spanId: 'span001',
    serviceName: 'web',
    environment: 'production',
    spanName: 'GET /api/checkout',
    httpStatusCode: 200,
    spanStatusCode: 1,
    durationMs: 50,
    startTimeMs: BASE_TIME_MS + 1000,
    exceptionCount: 0,
    attributes: {},
    ingestedAt: Date.now(),
    ...overrides,
  }
}

function makeMetric(overrides: Partial<TelemetryMetric> = {}): TelemetryMetric {
  return {
    service: 'web',
    environment: 'production',
    name: 'http.server.request.error_rate',
    startTimeMs: BASE_TIME_MS + 1000,
    summary: { asDouble: 0.85 },
    ingestedAt: Date.now(),
    ...overrides,
  }
}

function makeLog(overrides: Partial<TelemetryLog> = {}): TelemetryLog {
  return {
    service: 'web',
    environment: 'production',
    timestamp: new Date(BASE_TIME_MS + 1000).toISOString(),
    startTimeMs: BASE_TIME_MS + 1000,
    severity: 'ERROR',
    severityNumber: 17,
    body: 'Connection refused',
    bodyHash: 'abc123def456gh',
    attributes: {},
    ingestedAt: Date.now(),
    ...overrides,
  }
}

function makeSignal(overrides: Partial<AnomalousSignal> = {}): AnomalousSignal {
  return {
    signal: 'http_500',
    firstSeenAt: new Date(BASE_TIME_MS + 5000).toISOString(),
    entity: 'web',
    spanId: 'span001',
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('buildIncidentDetailExtension', () => {
  let telemetryStore: MemoryTelemetryAdapter

  beforeEach(() => {
    telemetryStore = new MemoryTelemetryAdapter()
  })

  // ── state.diagnosis ─────────────────────────────────────────────────────

  describe('state.diagnosis', () => {
    it('returns "ready" when diagnosisResult exists', async () => {
      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
      })

      const result = await buildIncidentDetailExtension(incident, telemetryStore)

      expect(result.state.diagnosis).toBe('ready')
    })

    it('returns "pending" when dispatched but no result', async () => {
      const incident = makeIncident({
        diagnosisDispatchedAt: new Date().toISOString(),
      })

      const result = await buildIncidentDetailExtension(incident, telemetryStore)

      expect(result.state.diagnosis).toBe('pending')
    })

    it('returns "unavailable" when no dispatch and no result', async () => {
      const incident = makeIncident()

      const result = await buildIncidentDetailExtension(incident, telemetryStore)

      expect(result.state.diagnosis).toBe('unavailable')
    })
  })

  // ── impactSummary.fullCascadeAt ─────────────────────────────────────────

  describe('impactSummary.fullCascadeAt', () => {
    it('sets fullCascadeAt when cross-service signal exists', async () => {
      const crossServiceTime = new Date(BASE_TIME_MS + 10_000).toISOString()
      const incident = makeIncident({
        anomalousSignals: [
          makeSignal({ entity: 'web', firstSeenAt: new Date(BASE_TIME_MS + 5000).toISOString() }),
          makeSignal({ entity: 'payment-service', firstSeenAt: crossServiceTime, spanId: 'span002' }),
        ],
      })

      const result = await buildIncidentDetailExtension(incident, telemetryStore)

      expect(result.impactSummary.fullCascadeAt).toBe(crossServiceTime)
    })

    it('sets fullCascadeAt to undefined when all signals are from primary service', async () => {
      const incident = makeIncident({
        anomalousSignals: [
          makeSignal({ entity: 'web', spanId: 'span001' }),
          makeSignal({ entity: 'web', spanId: 'span002' }),
        ],
      })

      const result = await buildIncidentDetailExtension(incident, telemetryStore)

      expect(result.impactSummary.fullCascadeAt).toBeUndefined()
    })
  })

  // ── impactSummary extraction ────────────────────────────────────────────

  describe('impactSummary', () => {
    it('extracts startedAt from packet.window.start', async () => {
      const incident = makeIncident()

      const result = await buildIncidentDetailExtension(incident, telemetryStore)

      expect(result.impactSummary.startedAt).toBe(incident.packet.window.start)
    })

    it('extracts diagnosedAt from diagnosisResult.metadata.created_at', async () => {
      const diagnosisResult = makeDiagnosisResult()
      const incident = makeIncident({ diagnosisResult })

      const result = await buildIncidentDetailExtension(incident, telemetryStore)

      expect(result.impactSummary.diagnosedAt).toBe(diagnosisResult.metadata.created_at)
    })

    it('sets diagnosedAt to undefined when no diagnosisResult', async () => {
      const incident = makeIncident()

      const result = await buildIncidentDetailExtension(incident, telemetryStore)

      expect(result.impactSummary.diagnosedAt).toBeUndefined()
    })
  })

  // ── Evidence density ────────────────────────────────────────────────────

  describe('state.evidenceDensity', () => {
    it('returns "rich" when traces > 5 && metrics > 3 && logs > 10', async () => {
      // 6 distinct traces (> 5)
      const spans: TelemetrySpan[] = []
      for (let i = 0; i < 6; i++) {
        spans.push(makeSpan({
          traceId: `trace-${i}`,
          spanId: `span-${i}`,
          startTimeMs: BASE_TIME_MS + i * 1000,
        }))
      }
      await telemetryStore.ingestSpans(spans)

      // 4 metrics (> 3)
      const metrics: TelemetryMetric[] = []
      for (let i = 0; i < 4; i++) {
        metrics.push(makeMetric({
          name: `metric_${i}`,
          startTimeMs: BASE_TIME_MS + i * 1000,
        }))
      }
      await telemetryStore.ingestMetrics(metrics)

      // 11 logs (> 10)
      const logs: TelemetryLog[] = []
      for (let i = 0; i < 11; i++) {
        logs.push(makeLog({
          bodyHash: `hash${i}`,
          startTimeMs: BASE_TIME_MS + i * 1000,
          timestamp: new Date(BASE_TIME_MS + i * 1000).toISOString(),
        }))
      }
      await telemetryStore.ingestLogs(logs)

      const incident = makeIncident()
      const result = await buildIncidentDetailExtension(incident, telemetryStore)

      expect(result.state.evidenceDensity).toBe('rich')
    })

    it('returns "sparse" when some data exists but not rich', async () => {
      // Just 1 span
      await telemetryStore.ingestSpans([
        makeSpan({ startTimeMs: BASE_TIME_MS + 1000 }),
      ])

      const incident = makeIncident()
      const result = await buildIncidentDetailExtension(incident, telemetryStore)

      expect(result.state.evidenceDensity).toBe('sparse')
    })

    it('returns "empty" when no data exists', async () => {
      const incident = makeIncident()
      const result = await buildIncidentDetailExtension(incident, telemetryStore)

      expect(result.state.evidenceDensity).toBe('empty')
    })
  })

  // ── Baseline state ─────────────────────────────────────────────────────

  describe('state.baseline', () => {
    it('returns "ready" when >= 20 baseline spans exist', async () => {
      const baselineStart = BASE_TIME_MS - 300_000
      const spans: TelemetrySpan[] = []
      for (let i = 0; i < 25; i++) {
        spans.push(makeSpan({
          traceId: `bl-${i}`,
          spanId: `bl-span-${i}`,
          startTimeMs: baselineStart + i * 10000,
        }))
      }
      await telemetryStore.ingestSpans(spans)

      const incident = makeIncident()
      const result = await buildIncidentDetailExtension(incident, telemetryStore)

      expect(result.state.baseline).toBe('ready')
    })

    it('returns "insufficient" when >= 1 and < 20 baseline spans', async () => {
      const baselineStart = BASE_TIME_MS - 300_000
      const spans: TelemetrySpan[] = []
      for (let i = 0; i < 5; i++) {
        spans.push(makeSpan({
          traceId: `bl-${i}`,
          spanId: `bl-span-${i}`,
          startTimeMs: baselineStart + i * 50000,
        }))
      }
      await telemetryStore.ingestSpans(spans)

      const incident = makeIncident()
      const result = await buildIncidentDetailExtension(incident, telemetryStore)

      expect(result.state.baseline).toBe('insufficient')
    })

    it('returns "unavailable" when 0 baseline spans', async () => {
      const incident = makeIncident()
      const result = await buildIncidentDetailExtension(incident, telemetryStore)

      expect(result.state.baseline).toBe('unavailable')
    })
  })

  // ── Evidence summary counts ────────────────────────────────────────────

  describe('evidenceSummary', () => {
    it('counts are accurate for mixed data', async () => {
      // 4 spans from 2 traces, 2 with errors
      await telemetryStore.ingestSpans([
        makeSpan({ traceId: 'tA', spanId: 's1', httpStatusCode: 200, spanStatusCode: 1, startTimeMs: BASE_TIME_MS + 1000 }),
        makeSpan({ traceId: 'tA', spanId: 's2', httpStatusCode: 500, spanStatusCode: 2, startTimeMs: BASE_TIME_MS + 2000 }),
        makeSpan({ traceId: 'tB', spanId: 's3', httpStatusCode: 200, spanStatusCode: 1, exceptionCount: 1, startTimeMs: BASE_TIME_MS + 3000 }),
        makeSpan({ traceId: 'tB', spanId: 's4', httpStatusCode: 200, spanStatusCode: 1, startTimeMs: BASE_TIME_MS + 4000 }),
      ])

      // 3 metrics
      await telemetryStore.ingestMetrics([
        makeMetric({ name: 'm1', startTimeMs: BASE_TIME_MS + 1000 }),
        makeMetric({ name: 'm2', startTimeMs: BASE_TIME_MS + 2000 }),
        makeMetric({ name: 'm3', startTimeMs: BASE_TIME_MS + 3000 }),
      ])

      // 5 logs, 2 ERROR + 1 FATAL = 3 errors
      await telemetryStore.ingestLogs([
        makeLog({ bodyHash: 'h1', severity: 'ERROR', startTimeMs: BASE_TIME_MS + 1000, timestamp: new Date(BASE_TIME_MS + 1000).toISOString() }),
        makeLog({ bodyHash: 'h2', severity: 'ERROR', startTimeMs: BASE_TIME_MS + 2000, timestamp: new Date(BASE_TIME_MS + 2000).toISOString() }),
        makeLog({ bodyHash: 'h3', severity: 'FATAL', severityNumber: 21, startTimeMs: BASE_TIME_MS + 3000, timestamp: new Date(BASE_TIME_MS + 3000).toISOString() }),
        makeLog({ bodyHash: 'h4', severity: 'WARN', severityNumber: 13, startTimeMs: BASE_TIME_MS + 4000, timestamp: new Date(BASE_TIME_MS + 4000).toISOString() }),
        makeLog({ bodyHash: 'h5', severity: 'WARN', severityNumber: 13, startTimeMs: BASE_TIME_MS + 5000, timestamp: new Date(BASE_TIME_MS + 5000).toISOString() }),
      ])

      const incident = makeIncident()
      const result = await buildIncidentDetailExtension(incident, telemetryStore)

      expect(result.evidenceSummary.traces).toBe(2)       // 2 distinct traceIds
      expect(result.evidenceSummary.traceErrors).toBe(2)   // 1 HTTP 500 + 1 exceptionCount
      expect(result.evidenceSummary.metrics).toBe(3)
      expect(result.evidenceSummary.metricsAnomalous).toBe(3) // Phase 1: all = anomalous
      expect(result.evidenceSummary.logs).toBe(5)
      expect(result.evidenceSummary.logErrors).toBe(3)     // 2 ERROR + 1 FATAL
    })

    it('returns all zeros when no data', async () => {
      const incident = makeIncident()
      const result = await buildIncidentDetailExtension(incident, telemetryStore)

      expect(result.evidenceSummary).toEqual({
        traces: 0,
        traceErrors: 0,
        metrics: 0,
        metricsAnomalous: 0,
        logs: 0,
        logErrors: 0,
      })
    })
  })

  // ── Integration: full incident ─────────────────────────────────────────

  describe('full incident integration', () => {
    it('returns valid extension with all fields populated', async () => {
      // Add incident-window data
      await telemetryStore.ingestSpans([
        makeSpan({ traceId: 't1', spanId: 's1', startTimeMs: BASE_TIME_MS + 1000, httpStatusCode: 500, spanStatusCode: 2 }),
        makeSpan({ traceId: 't2', spanId: 's2', startTimeMs: BASE_TIME_MS + 2000 }),
      ])
      await telemetryStore.ingestMetrics([
        makeMetric({ startTimeMs: BASE_TIME_MS + 1000 }),
      ])
      await telemetryStore.ingestLogs([
        makeLog({ bodyHash: 'l1', startTimeMs: BASE_TIME_MS + 1000, timestamp: new Date(BASE_TIME_MS + 1000).toISOString() }),
      ])

      const incident = makeIncident({
        diagnosisResult: makeDiagnosisResult(),
        anomalousSignals: [
          makeSignal({ entity: 'web' }),
          makeSignal({ entity: 'payment-service', spanId: 'span002', firstSeenAt: new Date(BASE_TIME_MS + 8000).toISOString() }),
        ],
      })

      const result = await buildIncidentDetailExtension(incident, telemetryStore)

      // impactSummary
      expect(result.impactSummary.startedAt).toBe(BASE_ISO)
      expect(result.impactSummary.fullCascadeAt).toBe(new Date(BASE_TIME_MS + 8000).toISOString())
      expect(result.impactSummary.diagnosedAt).toBeDefined()

      // blastRadius
      expect(result.blastRadius).toBeDefined()
      expect(result.blastRadiusRollup).toBeDefined()

      // confidencePrimitives
      expect(result.confidencePrimitives).toBeDefined()
      expect(result.confidencePrimitives.evidenceCoverage).toBeDefined()

      // evidenceSummary
      expect(result.evidenceSummary.traces).toBe(2)
      expect(result.evidenceSummary.traceErrors).toBe(1)
      expect(result.evidenceSummary.metrics).toBe(1)
      expect(result.evidenceSummary.logs).toBe(1)

      // state
      expect(result.state.diagnosis).toBe('ready')
      expect(result.state.evidenceDensity).toBe('sparse')
    })
  })
})
