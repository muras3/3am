/**
 * Integration tests for snapshot-builder.ts
 *
 * Tests the full E2E flow: incident creation via StorageDriver,
 * telemetry ingestion via TelemetryStoreDriver, rebuildSnapshots
 * orchestration, and verification of packet evidence.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryAdapter } from '../../storage/adapters/memory.js'
import { MemoryTelemetryAdapter } from '../../telemetry/adapters/memory.js'
import { rebuildSnapshots } from '../../telemetry/snapshot-builder.js'
import { createPacket, buildAnomalousSignals } from '../../domain/packetizer.js'
import { isAnomalous } from '../../domain/anomaly-detector.js'
import type { ExtractedSpan } from '../../domain/anomaly-detector.js'
import type { TelemetrySpan, TelemetryMetric, TelemetryLog } from '../../telemetry/interface.js'
import {
  MAX_CHANGED_METRICS,
  MAX_RELEVANT_LOGS,
  MAX_TRACE_REFS,
} from '../../telemetry/constants.js'
import { MAX_REPRESENTATIVE_TRACES } from '../../domain/packetizer.js'

// ── Test helpers ─────────────────────────────────────────────────────────────

const BASE_TIME_MS = 1741392000000 // 2025-03-07T16:00:00Z

function makeExtractedSpan(overrides: Partial<ExtractedSpan> = {}): ExtractedSpan {
  return {
    traceId: 'trace001',
    spanId: 'span001',
    serviceName: 'web',
    environment: 'production',
    httpRoute: '/checkout',
    httpStatusCode: 500,
    spanStatusCode: 2,
    durationMs: 500,
    startTimeMs: BASE_TIME_MS,
    exceptionCount: 0,
    ...overrides,
  }
}

function makeTelemetrySpan(overrides: Partial<TelemetrySpan> = {}): TelemetrySpan {
  return {
    traceId: 'trace001',
    spanId: 'span001',
    serviceName: 'web',
    environment: 'production',
    spanName: 'POST /checkout',
    httpRoute: '/checkout',
    httpStatusCode: 500,
    spanStatusCode: 2,
    durationMs: 500,
    startTimeMs: BASE_TIME_MS,
    exceptionCount: 0,
    attributes: {},
    ingestedAt: Date.now(),
    ...overrides,
  }
}

function makeTelemetryMetric(overrides: Partial<TelemetryMetric> = {}): TelemetryMetric {
  return {
    service: 'web',
    environment: 'production',
    name: 'http.server.request.error_rate',
    startTimeMs: BASE_TIME_MS,
    summary: { asDouble: 0.85 },
    ingestedAt: Date.now(),
    ...overrides,
  }
}

function makeTelemetryLog(overrides: Partial<TelemetryLog> = {}): TelemetryLog {
  return {
    service: 'web',
    environment: 'production',
    timestamp: new Date(BASE_TIME_MS).toISOString(),
    startTimeMs: BASE_TIME_MS,
    severity: 'ERROR',
    severityNumber: 17,
    body: 'Connection refused to database',
    bodyHash: 'abc123def456gh78',
    attributes: {},
    ingestedAt: Date.now(),
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('rebuildSnapshots', () => {
  let storage: MemoryAdapter
  let telemetryStore: MemoryTelemetryAdapter

  beforeEach(() => {
    storage = new MemoryAdapter()
    telemetryStore = new MemoryTelemetryAdapter()
  })

  describe('E2E flow', () => {
    it('creates 3 snapshots and updates packet evidence from TelemetryStore data', async () => {
      // 1. Create incident via storage
      const spans: ExtractedSpan[] = [
        makeExtractedSpan({ traceId: 'trace001', spanId: 'span001' }),
        makeExtractedSpan({ traceId: 'trace002', spanId: 'span002', httpStatusCode: 200, spanStatusCode: 0 }),
      ]
      const incidentId = 'inc_test_001'
      const openedAt = new Date(BASE_TIME_MS).toISOString()
      const packet = createPacket(incidentId, openedAt, spans, 'web')
      await storage.createIncident(packet)
      await storage.appendSpans(incidentId, spans)
      await storage.appendAnomalousSignals(incidentId, buildAnomalousSignals(spans.filter(isAnomalous)))

      // 2. Ingest telemetry data to TelemetryStore
      const tsSpans = [
        makeTelemetrySpan({ traceId: 'trace001', spanId: 'span001' }),
        makeTelemetrySpan({ traceId: 'trace002', spanId: 'span002', httpStatusCode: 200, spanStatusCode: 0 }),
        makeTelemetrySpan({ traceId: 'trace003', spanId: 'span003', httpStatusCode: 503, spanStatusCode: 2 }),
      ]
      await telemetryStore.ingestSpans(tsSpans)

      const tsMetrics = [
        makeTelemetryMetric({ name: 'http.server.request.error_rate', startTimeMs: BASE_TIME_MS }),
        makeTelemetryMetric({ name: 'http.server.request.duration', startTimeMs: BASE_TIME_MS + 100, summary: { asDouble: 2500 } }),
      ]
      await telemetryStore.ingestMetrics(tsMetrics)

      const tsLogs = [
        makeTelemetryLog({ body: 'Connection refused', bodyHash: 'hash001', startTimeMs: BASE_TIME_MS }),
        makeTelemetryLog({ body: 'Timeout exceeded', bodyHash: 'hash002', startTimeMs: BASE_TIME_MS + 500, severity: 'WARN', severityNumber: 13 }),
      ]
      await telemetryStore.ingestLogs(tsLogs)

      // 3. Call rebuildSnapshots
      await rebuildSnapshots(incidentId, telemetryStore, storage)

      // 4. Verify 3 snapshots created
      const snapshots = await telemetryStore.getSnapshots(incidentId)
      expect(snapshots.length).toBe(3)

      const snapshotTypes = snapshots.map(s => s.snapshotType).sort()
      expect(snapshotTypes).toEqual(['logs', 'metrics', 'traces'])

      // 5. Verify packet evidence is updated with scored/selected data
      const updatedIncident = await storage.getIncident(incidentId)
      expect(updatedIncident).not.toBeNull()

      const updatedPacket = updatedIncident!.packet
      // Traces should be from TelemetryStore (3 spans available)
      expect(updatedPacket.evidence.representativeTraces.length).toBeGreaterThan(0)
      expect(updatedPacket.evidence.representativeTraces.length).toBeLessThanOrEqual(MAX_REPRESENTATIVE_TRACES)

      // Metrics should be selected + scored
      expect(updatedPacket.evidence.changedMetrics.length).toBe(2)
      expect(updatedPacket.evidence.changedMetrics.length).toBeLessThanOrEqual(MAX_CHANGED_METRICS)

      // Logs should be selected + scored
      expect(updatedPacket.evidence.relevantLogs.length).toBe(2)
      expect(updatedPacket.evidence.relevantLogs.length).toBeLessThanOrEqual(MAX_RELEVANT_LOGS)

      // Pointers should be from snapshot data
      expect(updatedPacket.pointers.traceRefs.length).toBeGreaterThan(0)
      expect(updatedPacket.pointers.traceRefs.length).toBeLessThanOrEqual(MAX_TRACE_REFS)
      expect(updatedPacket.pointers.metricRefs.length).toBeGreaterThan(0)

      // Generation should be incremented
      expect(updatedPacket.generation).toBe(2)
    })

    it('respects MAX output sizes when many items are available', async () => {
      const incidentId = 'inc_test_overflow'
      const openedAt = new Date(BASE_TIME_MS).toISOString()
      const spans: ExtractedSpan[] = [
        makeExtractedSpan({ traceId: 'trigger', spanId: 'trigger_span' }),
      ]
      const packet = createPacket(incidentId, openedAt, spans, 'web')
      await storage.createIncident(packet)
      await storage.appendSpans(incidentId, spans)
      await storage.appendAnomalousSignals(incidentId, buildAnomalousSignals(spans.filter(isAnomalous)))

      // Ingest many metrics (> MAX_CHANGED_METRICS)
      const manyMetrics: TelemetryMetric[] = Array.from({ length: 30 }, (_, i) =>
        makeTelemetryMetric({
          name: `metric_${i}`,
          startTimeMs: BASE_TIME_MS + i * 100,
          summary: { asDouble: i * 10 },
        }),
      )
      await telemetryStore.ingestMetrics(manyMetrics)

      // Ingest many logs (> MAX_RELEVANT_LOGS)
      const manyLogs: TelemetryLog[] = Array.from({ length: 40 }, (_, i) =>
        makeTelemetryLog({
          body: `Error message ${i}`,
          bodyHash: `hash_${String(i).padStart(4, '0')}`,
          startTimeMs: BASE_TIME_MS + i * 100,
          timestamp: new Date(BASE_TIME_MS + i * 100).toISOString(),
        }),
      )
      await telemetryStore.ingestLogs(manyLogs)

      // Ingest the trigger span
      await telemetryStore.ingestSpans([
        makeTelemetrySpan({ traceId: 'trigger', spanId: 'trigger_span' }),
      ])

      await rebuildSnapshots(incidentId, telemetryStore, storage)

      const updatedIncident = await storage.getIncident(incidentId)
      expect(updatedIncident).not.toBeNull()
      expect(updatedIncident!.packet.evidence.changedMetrics.length).toBeLessThanOrEqual(MAX_CHANGED_METRICS)
      expect(updatedIncident!.packet.evidence.relevantLogs.length).toBeLessThanOrEqual(MAX_RELEVANT_LOGS)
    })

    it('changedMetrics omit score field (clean packet types)', async () => {
      const incidentId = 'inc_clean_types'
      const openedAt = new Date(BASE_TIME_MS).toISOString()
      const spans: ExtractedSpan[] = [makeExtractedSpan()]
      const packet = createPacket(incidentId, openedAt, spans, 'web')
      await storage.createIncident(packet)
      await storage.appendSpans(incidentId, spans)
      await storage.appendAnomalousSignals(incidentId, buildAnomalousSignals(spans.filter(isAnomalous)))

      await telemetryStore.ingestSpans([makeTelemetrySpan()])
      await telemetryStore.ingestMetrics([makeTelemetryMetric()])
      await telemetryStore.ingestLogs([makeTelemetryLog()])

      await rebuildSnapshots(incidentId, telemetryStore, storage)

      const updated = await storage.getIncident(incidentId)
      expect(updated).not.toBeNull()

      // Verify no score field leaked into packet types
      for (const m of updated!.packet.evidence.changedMetrics) {
        expect(m).not.toHaveProperty('score')
      }
      for (const l of updated!.packet.evidence.relevantLogs) {
        expect(l).not.toHaveProperty('score')
        expect(l).not.toHaveProperty('groupCount')
        expect(l).not.toHaveProperty('severityNumber')
        expect(l).not.toHaveProperty('bodyHash')
        expect(l).not.toHaveProperty('traceId')
        expect(l).not.toHaveProperty('spanId')
      }
    })
  })

  describe('stale avoidance', () => {
    it('picks up newly appended data when called with just incidentId', async () => {
      const incidentId = 'inc_stale_test'
      const openedAt = new Date(BASE_TIME_MS).toISOString()

      // Initial incident with one span
      const span1 = makeExtractedSpan({ traceId: 'trace_old', spanId: 'span_old' })
      const packet = createPacket(incidentId, openedAt, [span1], 'web')
      await storage.createIncident(packet)
      await storage.appendSpans(incidentId, [span1])
      await storage.appendAnomalousSignals(incidentId, buildAnomalousSignals([span1].filter(isAnomalous)))

      await telemetryStore.ingestSpans([
        makeTelemetrySpan({ traceId: 'trace_old', spanId: 'span_old' }),
      ])

      // First rebuild
      await rebuildSnapshots(incidentId, telemetryStore, storage)
      let updated = await storage.getIncident(incidentId)
      expect(updated!.packet.pointers.traceRefs).toContain('trace_old')

      // Append more spans (simulating another ingest batch)
      const span2 = makeExtractedSpan({
        traceId: 'trace_new',
        spanId: 'span_new',
        startTimeMs: BASE_TIME_MS + 1000,
      })
      await storage.appendSpans(incidentId, [span2])
      await storage.appendAnomalousSignals(incidentId, buildAnomalousSignals([span2].filter(isAnomalous)))

      // Ingest new span to TelemetryStore
      await telemetryStore.ingestSpans([
        makeTelemetrySpan({
          traceId: 'trace_new',
          spanId: 'span_new',
          startTimeMs: BASE_TIME_MS + 1000,
        }),
      ])

      // Rebuild again — should pick up the new data
      await rebuildSnapshots(incidentId, telemetryStore, storage)
      updated = await storage.getIncident(incidentId)
      expect(updated!.packet.pointers.traceRefs).toContain('trace_old')
      expect(updated!.packet.pointers.traceRefs).toContain('trace_new')
    })
  })

  describe('no-op cases', () => {
    it('returns early when incident does not exist', async () => {
      // Should not throw
      await rebuildSnapshots('inc_nonexistent', telemetryStore, storage)

      // No snapshots created
      const snapshots = await telemetryStore.getSnapshots('inc_nonexistent')
      expect(snapshots.length).toBe(0)
    })

    it('returns early when rawState has no spans', async () => {
      // Create incident but don't append any spans to rawState
      const incidentId = 'inc_no_spans'
      const openedAt = new Date(BASE_TIME_MS).toISOString()
      // Create packet with a minimal span — then rawState will have empty spans
      // because we are not calling appendSpans
      const span = makeExtractedSpan()
      const packet = createPacket(incidentId, openedAt, [span], 'web')
      await storage.createIncident(packet)
      // Don't call appendSpans — rawState.spans will be empty

      // Should handle gracefully
      await rebuildSnapshots(incidentId, telemetryStore, storage)

      // No snapshots because rawState.spans is empty → no window to compute
      const snapshots = await telemetryStore.getSnapshots(incidentId)
      expect(snapshots.length).toBe(0)
    })
  })

  describe('pointers from snapshot', () => {
    it('traceRefs come from TelemetryStore spans (broader than representativeTraces)', async () => {
      const incidentId = 'inc_pointers_test'
      const openedAt = new Date(BASE_TIME_MS).toISOString()

      // Create incident with a few spans
      const incidentSpans: ExtractedSpan[] = Array.from({ length: 3 }, (_, i) =>
        makeExtractedSpan({
          traceId: `trace_${i}`,
          spanId: `span_${i}`,
          startTimeMs: BASE_TIME_MS + i * 100,
        }),
      )
      const packet = createPacket(incidentId, openedAt, incidentSpans, 'web')
      await storage.createIncident(packet)
      await storage.appendSpans(incidentId, incidentSpans)
      await storage.appendAnomalousSignals(incidentId, buildAnomalousSignals(incidentSpans.filter(isAnomalous)))

      // Ingest MORE spans to TelemetryStore than what's in rawState
      // (simulating spans that arrived before incident detection)
      const allTsSpans: TelemetrySpan[] = Array.from({ length: 15 }, (_, i) =>
        makeTelemetrySpan({
          traceId: `trace_${i}`,
          spanId: `span_${i}`,
          startTimeMs: BASE_TIME_MS + i * 50,
          httpStatusCode: i < 3 ? 500 : 200,
          spanStatusCode: i < 3 ? 2 : 0,
        }),
      )
      await telemetryStore.ingestSpans(allTsSpans)

      await rebuildSnapshots(incidentId, telemetryStore, storage)

      const updated = await storage.getIncident(incidentId)
      expect(updated).not.toBeNull()

      // traceRefs should include all distinct traceIds from TelemetryStore query
      // (up to MAX_TRACE_REFS), not just the representative traces
      expect(updated!.packet.pointers.traceRefs.length).toBe(15) // all 15 distinct traces
      expect(updated!.packet.evidence.representativeTraces.length).toBeLessThanOrEqual(MAX_REPRESENTATIVE_TRACES)
      // traceRefs is broader than representativeTraces
      expect(updated!.packet.pointers.traceRefs.length).toBeGreaterThanOrEqual(
        updated!.packet.evidence.representativeTraces.length,
      )
    })

    it('metricRefs come from selected metrics (not all ingested)', async () => {
      const incidentId = 'inc_metric_refs'
      const openedAt = new Date(BASE_TIME_MS).toISOString()
      const spans: ExtractedSpan[] = [makeExtractedSpan()]
      const packet = createPacket(incidentId, openedAt, spans, 'web')
      await storage.createIncident(packet)
      await storage.appendSpans(incidentId, spans)
      await storage.appendAnomalousSignals(incidentId, buildAnomalousSignals(spans.filter(isAnomalous)))

      await telemetryStore.ingestSpans([makeTelemetrySpan()])
      await telemetryStore.ingestMetrics([
        makeTelemetryMetric({ name: 'http.server.request.error_rate' }),
        makeTelemetryMetric({ name: 'http.server.request.duration', summary: { asDouble: 150 } }),
      ])

      await rebuildSnapshots(incidentId, telemetryStore, storage)

      const updated = await storage.getIncident(incidentId)
      expect(updated).not.toBeNull()

      // metricRefs should contain the names of selected metrics
      expect(updated!.packet.pointers.metricRefs).toContain('http.server.request.error_rate')
      expect(updated!.packet.pointers.metricRefs).toContain('http.server.request.duration')
    })

    it('logRefs use service:timestamp format from selected logs', async () => {
      const incidentId = 'inc_log_refs'
      const openedAt = new Date(BASE_TIME_MS).toISOString()
      const spans: ExtractedSpan[] = [makeExtractedSpan()]
      const packet = createPacket(incidentId, openedAt, spans, 'web')
      await storage.createIncident(packet)
      await storage.appendSpans(incidentId, spans)
      await storage.appendAnomalousSignals(incidentId, buildAnomalousSignals(spans.filter(isAnomalous)))

      await telemetryStore.ingestSpans([makeTelemetrySpan()])
      const logTimestamp = new Date(BASE_TIME_MS).toISOString()
      await telemetryStore.ingestLogs([
        makeTelemetryLog({ timestamp: logTimestamp }),
      ])

      await rebuildSnapshots(incidentId, telemetryStore, storage)

      const updated = await storage.getIncident(incidentId)
      expect(updated).not.toBeNull()

      // logRefs should be service:timestamp
      expect(updated!.packet.pointers.logRefs).toContain(`web:${logTimestamp}`)
    })

    it('platformLogRefs come from rawState platformEvents (unchanged)', async () => {
      const incidentId = 'inc_platform_refs'
      const openedAt = new Date(BASE_TIME_MS).toISOString()
      const spans: ExtractedSpan[] = [makeExtractedSpan()]
      const packet = createPacket(incidentId, openedAt, spans, 'web')
      await storage.createIncident(packet)
      await storage.appendSpans(incidentId, spans)
      await storage.appendAnomalousSignals(incidentId, buildAnomalousSignals(spans.filter(isAnomalous)))

      // Add platform events
      await storage.appendPlatformEvents(incidentId, [{
        eventType: 'deploy',
        timestamp: new Date(BASE_TIME_MS).toISOString(),
        environment: 'production',
        description: 'Deployed v2.0',
        eventId: 'deploy_001',
      }])

      await telemetryStore.ingestSpans([makeTelemetrySpan()])

      await rebuildSnapshots(incidentId, telemetryStore, storage)

      const updated = await storage.getIncident(incidentId)
      expect(updated).not.toBeNull()

      // platformLogRefs should come from rawState
      expect(updated!.packet.pointers.platformLogRefs).toContain('deploy_001')
    })
  })

  describe('multi-service diversity', () => {
    it('selects evidence from multiple services', async () => {
      const incidentId = 'inc_diversity'
      const openedAt = new Date(BASE_TIME_MS).toISOString()

      // Create incident with spans from multiple services
      const spans: ExtractedSpan[] = [
        makeExtractedSpan({ traceId: 'trace_web', spanId: 'span_web', serviceName: 'web' }),
        makeExtractedSpan({
          traceId: 'trace_api',
          spanId: 'span_api',
          serviceName: 'api',
          startTimeMs: BASE_TIME_MS + 100,
        }),
      ]
      const packet = createPacket(incidentId, openedAt, spans, 'web')
      await storage.createIncident(packet)
      await storage.appendSpans(incidentId, spans)
      await storage.appendAnomalousSignals(incidentId, buildAnomalousSignals(spans.filter(isAnomalous)))

      // Ingest metrics from multiple services
      await telemetryStore.ingestSpans([
        makeTelemetrySpan({ serviceName: 'web', traceId: 'trace_web', spanId: 'span_web' }),
        makeTelemetrySpan({ serviceName: 'api', traceId: 'trace_api', spanId: 'span_api', startTimeMs: BASE_TIME_MS + 100 }),
      ])
      await telemetryStore.ingestMetrics([
        makeTelemetryMetric({ service: 'web', name: 'http.server.request.error_rate' }),
        makeTelemetryMetric({ service: 'api', name: 'http.server.request.error_rate' }),
      ])
      await telemetryStore.ingestLogs([
        makeTelemetryLog({ service: 'web', body: 'Error in web', bodyHash: 'hash_web' }),
        makeTelemetryLog({ service: 'api', body: 'Error in api', bodyHash: 'hash_api' }),
      ])

      await rebuildSnapshots(incidentId, telemetryStore, storage)

      const updated = await storage.getIncident(incidentId)
      expect(updated).not.toBeNull()

      // Metrics should have entries from both services
      const metricServices = new Set(updated!.packet.evidence.changedMetrics.map(m => m.service))
      expect(metricServices.size).toBe(2)
      expect(metricServices.has('web')).toBe(true)
      expect(metricServices.has('api')).toBe(true)

      // Logs should have entries from both services
      const logServices = new Set(updated!.packet.evidence.relevantLogs.map(l => l.service))
      expect(logServices.size).toBe(2)
    })
  })
})
