/**
 * curated-evidence.ts — Orchestrator for GET /api/incidents/:id/evidence.
 *
 * Runs all 3 surface builders in parallel (traces, metrics, logs),
 * merges their EvidenceRef maps into a single EvidenceIndex,
 * and assembles the CuratedEvidenceResponse.
 *
 * proofCards, qa, and sideNotes are left empty — diagnosis Stage 2 fills them.
 */

import type { TelemetryStoreDriver } from '../telemetry/interface.js'
import type { Incident } from '../storage/interface.js'
import type { CuratedEvidenceResponse, EvidenceIndex } from '@3amoncall/core/schemas/curated-evidence'
import { buildTraceSurface } from './trace-surface.js'
import { buildMetricsSurface } from './metrics-surface.js'
import { buildLogsSurface } from './logs-surface.js'

export async function buildCuratedEvidence(
  incident: Incident,
  telemetryStore: TelemetryStoreDriver,
): Promise<CuratedEvidenceResponse> {
  // 1. Run all 3 surface builders in parallel
  const [traceResult, metricsResult, logsResult] = await Promise.all([
    buildTraceSurface(incident, telemetryStore),
    buildMetricsSurface(
      telemetryStore,
      incident.telemetryScope,
      incident.anomalousSignals,
    ),
    buildLogsSurface(
      telemetryStore,
      incident.telemetryScope,
      incident.anomalousSignals,
      incident.spanMembership,
    ),
  ])

  // 2. Merge evidenceRefs from all surfaces into a single EvidenceIndex
  const evidenceIndex: EvidenceIndex = {
    spans: {},
    metrics: {},
    logs: {},
    absences: {},
  }

  for (const [refId, ref] of traceResult.evidenceRefs) {
    evidenceIndex.spans[refId] = ref
  }

  for (const [refId, ref] of metricsResult.evidenceRefs) {
    evidenceIndex.metrics[refId] = ref
  }

  for (const [refId, ref] of logsResult.evidenceRefs) {
    if (ref.surface === 'absences') {
      evidenceIndex.absences[refId] = ref
    } else {
      evidenceIndex.logs[refId] = ref
    }
  }

  // 3. Determine state
  const diagnosis: CuratedEvidenceResponse['state']['diagnosis'] =
    incident.diagnosisResult
      ? 'ready'
      : incident.diagnosisDispatchedAt
        ? 'pending'
        : 'unavailable'

  const baselineConfidence = traceResult.surface.baseline.confidence
  const baseline: CuratedEvidenceResponse['state']['baseline'] =
    baselineConfidence === 'high' || baselineConfidence === 'medium'
      ? 'ready'
      : baselineConfidence === 'low'
        ? 'insufficient'
        : 'unavailable'

  // 3b. Determine evidenceDensity
  const traceCount = traceResult.surface.observed.length
  const metricCount = metricsResult.surface.groups.reduce(
    (sum, g) => sum + g.rows.length, 0,
  )
  const logCount = logsResult.surface.clusters.reduce(
    (sum, c) => sum + c.entries.length, 0,
  )
  const evidenceDensity: CuratedEvidenceResponse['state']['evidenceDensity'] =
    traceCount > 5 && metricCount > 3 && logCount > 10
      ? 'rich'
      : traceCount > 0 || metricCount > 0 || logCount > 0
        ? 'sparse'
        : 'empty'

  // 4. Return assembled response
  return {
    proofCards: [],
    qa: null,
    sideNotes: [],
    surfaces: {
      traces: traceResult.surface,
      metrics: metricsResult.surface,
      logs: logsResult.surface,
    },
    evidenceIndex,
    state: { diagnosis, baseline, evidenceDensity },
  }
}
