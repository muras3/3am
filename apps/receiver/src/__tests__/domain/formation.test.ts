import { describe, it, expect } from 'vitest'
import { buildFormationKey, shouldAttachToIncident, FORMATION_WINDOW_MS } from '../../domain/formation.js'
import type { ExtractedSpan } from '../../domain/anomaly-detector.js'
import type { Incident } from '../../storage/interface.js'
import type { IncidentPacket } from '@3amoncall/core'

// Minimal IncidentPacket fixture — only fields needed for formation logic
function makePacket(environment: string, primaryService: string): IncidentPacket {
  return {
    schemaVersion: 'incident-packet/v1alpha1',
    packetId: 'pkt_test',
    incidentId: 'inc_test',
    openedAt: new Date().toISOString(),
    window: {
      start: new Date().toISOString(),
      detect: new Date().toISOString(),
      end: new Date().toISOString(),
    },
    scope: {
      environment,
      primaryService,
      affectedServices: [],
      affectedRoutes: [],
      affectedDependencies: [],
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

function makeIncident(
  environment: string,
  primaryService: string,
  openedAt: string,
  status: 'open' | 'closed' = 'open',
): Incident {
  return {
    incidentId: 'inc_test',
    status,
    openedAt,
    packet: makePacket(environment, primaryService),
    rawState: { spans: [], anomalousSignals: [], metricEvidence: [], logEvidence: [], platformEvents: [] },
  }
}

const BASE_SPAN: ExtractedSpan = {
  traceId: 'trace1',
  spanId: 'span1',
  serviceName: 'api-service',
  environment: 'production',
  httpStatusCode: 500,
  spanStatusCode: 2,
  durationMs: 100,
  startTimeMs: 1700000000000,
  exceptionCount: 0,
}

describe('buildFormationKey', () => {
  it('returns environment matching span.environment', () => {
    const key = buildFormationKey(BASE_SPAN)
    expect(key.environment).toBe('production')
  })

  it('returns primaryService matching span.serviceName', () => {
    const key = buildFormationKey(BASE_SPAN)
    expect(key.primaryService).toBe('api-service')
  })

  it('timeWindow.start is ISO string of span.startTimeMs', () => {
    const key = buildFormationKey(BASE_SPAN)
    expect(key.timeWindow.start).toBe(new Date(BASE_SPAN.startTimeMs).toISOString())
  })

  it('timeWindow.end is ISO string of span.startTimeMs + 5 minutes', () => {
    const key = buildFormationKey(BASE_SPAN)
    expect(key.timeWindow.end).toBe(
      new Date(BASE_SPAN.startTimeMs + FORMATION_WINDOW_MS).toISOString(),
    )
  })
})

describe('shouldAttachToIncident', () => {
  const openedAt = new Date(BASE_SPAN.startTimeMs).toISOString()
  const key = buildFormationKey(BASE_SPAN)

  it('returns true when env+service match AND signal is 4 minutes after openedAt (within 5min)', () => {
    const incident = makeIncident('production', 'api-service', openedAt)
    const signalTimeMs = BASE_SPAN.startTimeMs + 4 * 60 * 1000 // 4 min later
    expect(shouldAttachToIncident(key, incident, signalTimeMs)).toBe(true)
  })

  it('returns false when signal is 6 minutes after openedAt (outside 5min window)', () => {
    const incident = makeIncident('production', 'api-service', openedAt)
    const signalTimeMs = BASE_SPAN.startTimeMs + 6 * 60 * 1000 // 6 min later
    expect(shouldAttachToIncident(key, incident, signalTimeMs)).toBe(false)
  })

  it('returns false when incident.status === "closed"', () => {
    const incident = makeIncident('production', 'api-service', openedAt, 'closed')
    const signalTimeMs = BASE_SPAN.startTimeMs + 1 * 60 * 1000 // 1 min later
    expect(shouldAttachToIncident(key, incident, signalTimeMs)).toBe(false)
  })

  it('returns false when environment differs', () => {
    const incident = makeIncident('staging', 'api-service', openedAt)
    const signalTimeMs = BASE_SPAN.startTimeMs + 1 * 60 * 1000
    expect(shouldAttachToIncident(key, incident, signalTimeMs)).toBe(false)
  })

  it('returns false when primaryService differs', () => {
    const incident = makeIncident('production', 'other-service', openedAt)
    const signalTimeMs = BASE_SPAN.startTimeMs + 1 * 60 * 1000
    expect(shouldAttachToIncident(key, incident, signalTimeMs)).toBe(false)
  })
})
