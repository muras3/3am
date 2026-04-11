/**
 * reasoning-structure-builder.ts — builds ReasoningStructure for stage 2 narrative generation.
 *
 * Reuses existing selectors from blast-radius and absence-detector.
 * Produces the deterministic context that diagnosis reads.
 */

import type { ReasoningStructure, ProofRef, BlastRadiusTarget, AbsenceCandidate } from "3am-core";
import type { TelemetryStoreDriver, TelemetrySpan, TelemetryLog } from "../telemetry/interface.js";
import { buildIncidentQueryFilter } from "../telemetry/interface.js";
import type { Incident, TelemetryScope, AnomalousSignal } from "../storage/interface.js";
import { computeBlastRadiusFromSpans } from "./blast-radius.js";
import { ABSENCE_PATTERNS } from "./absence-detector.js";
import { computeEvidenceCounts } from "./evidence-counts.js";

// ── Public API ────────────────────────────────────────────────────────────

export async function buildReasoningStructure(
  incident: Incident,
  telemetryStore: TelemetryStoreDriver,
): Promise<ReasoningStructure> {
  const { telemetryScope, anomalousSignals } = incident;
  const incidentFilter = buildIncidentQueryFilter(telemetryScope);

  // Single set of queries — blast radius uses the same spans (no duplicate query)
  const [spans, metrics, logs] = await Promise.all([
    telemetryStore.querySpans(incidentFilter),
    telemetryStore.queryMetrics(incidentFilter),
    telemetryStore.queryLogs(incidentFilter),
  ]);

  const counts = computeEvidenceCounts(spans, logs);
  const { entries: blastEntries } = computeBlastRadiusFromSpans(spans);

  const blastRadius: BlastRadiusTarget[] = blastEntries.map((entry) => ({
    targetId: entry.targetId,
    label: entry.label,
    status: entry.status,
    impactValue: entry.impactValue,
    displayValue: entry.displayValue,
  }));

  const proofRefs = buildProofRefs(spans, logs, anomalousSignals);

  const absenceCandidates = buildAbsenceCandidates(
    logs,
    anomalousSignals,
    telemetryScope,
  );

  const primaryService = incident.packet.scope.primaryService;
  const crossServiceSignal = anomalousSignals.find(
    (s) => s.entity !== primaryService,
  );

  const availableEvidenceKinds: ("traces" | "metrics" | "logs")[] = [];
  if (counts.traceIds > 0) availableEvidenceKinds.push("traces");
  if (metrics.length > 0) availableEvidenceKinds.push("metrics");
  if (logs.length > 0) availableEvidenceKinds.push("logs");

  return {
    incidentId: incident.incidentId,
    evidenceCounts: {
      traces: counts.traceIds,
      traceErrors: counts.traceErrors,
      metrics: metrics.length,
      logs: logs.length,
      logErrors: counts.logErrors,
    },
    blastRadius,
    proofRefs,
    absenceCandidates,
    timelineSummary: {
      startedAt: incident.packet.window.start,
      fullCascadeAt: crossServiceSignal?.firstSeenAt ?? null,
      diagnosedAt: incident.diagnosisResult?.metadata.created_at ?? null,
    },
    qaContext: {
      availableEvidenceKinds,
    },
  };
}

// ── Dependency failure predicate ────────────────────────────────────────

function hasDependencyFailure(anomalousSignals: AnomalousSignal[]): boolean {
  return anomalousSignals.some(
    (s) => s.signal.includes("429") || /^http_5\d\d$/.test(s.signal) || s.signal === "http_5xx",
  );
}

// ── Proof ref derivation ────────────────────────────────────────────────

function buildProofRefs(
  spans: TelemetrySpan[],
  logs: TelemetryLog[],
  anomalousSignals: AnomalousSignal[],
): ProofRef[] {
  const refs: ProofRef[] = [];

  // Trigger proof card — error spans as evidence
  const errorSpans = spans.filter(
    (s) =>
      (s.httpStatusCode !== undefined && s.httpStatusCode >= 500) ||
      s.httpStatusCode === 429 ||
      s.spanStatusCode === 2,
  );
  if (errorSpans.length > 0) {
    refs.push({
      cardId: "trigger",
      targetSurface: "traces",
      evidenceRefs: errorSpans.slice(0, 5).map((s) => ({
        kind: "span" as const,
        id: `${s.traceId}:${s.spanId}`,
      })),
      status: errorSpans.length >= 3 ? "confirmed" : "inferred",
    });
  } else {
    refs.push({
      cardId: "trigger",
      targetSurface: "logs",
      evidenceRefs: [],
      status: "pending",
    });
  }

  // Design gap proof card — absence of resilience patterns
  const depFailure = hasDependencyFailure(anomalousSignals);
  const retryLogs = logs.filter((l) =>
    /retry|backoff|circuit.?breaker/i.test(l.body),
  );
  if (depFailure && retryLogs.length === 0) {
    refs.push({
      cardId: "design_gap",
      targetSurface: "logs",
      evidenceRefs: [],
      status: "inferred",
    });
  } else if (depFailure && retryLogs.length > 0) {
    refs.push({
      cardId: "design_gap",
      targetSurface: "logs",
      evidenceRefs: retryLogs.slice(0, 3).map((l) => ({
        kind: "log" as const,
        id: `${l.service}:${l.timestamp}:${l.bodyHash}`,
      })),
      status: "confirmed",
    });
  } else {
    refs.push({
      cardId: "design_gap",
      targetSurface: "logs",
      evidenceRefs: [],
      status: "pending",
    });
  }

  // Recovery proof card
  const recoveryLogs = logs.filter((l) =>
    /recover|resolv|restored|healthy|back.?to.?normal/i.test(l.body),
  );
  refs.push({
    cardId: "recovery",
    targetSurface: "logs",
    evidenceRefs: recoveryLogs.slice(0, 3).map((l) => ({
      kind: "log" as const,
      id: `${l.service}:${l.timestamp}:${l.bodyHash}`,
    })),
    status: recoveryLogs.length > 0 ? "confirmed" : "pending",
  });

  return refs;
}

// ── Absence candidate derivation ────────────────────────────────────────

function buildAbsenceCandidates(
  logs: TelemetryLog[],
  anomalousSignals: AnomalousSignal[],
  scope: TelemetryScope,
): AbsenceCandidate[] {
  if (!hasDependencyFailure(anomalousSignals)) return [];

  const candidates: AbsenceCandidate[] = [];

  for (const pattern of ABSENCE_PATTERNS) {
    // Use pattern's own triggerCondition if available
    if (!pattern.triggerCondition(anomalousSignals)) continue;

    const lowerKeywords = pattern.keywords.map((kw) => kw.toLowerCase());
    const matchCount = logs.filter((l) => {
      const lowerBody = l.body.toLowerCase();
      return lowerKeywords.some((kw) => lowerBody.includes(kw));
    }).length;

    if (matchCount === 0) {
      candidates.push({
        id: pattern.patternId,
        patterns: [...pattern.keywords],
        searchWindow: {
          startMs: scope.windowStartMs,
          endMs: scope.windowEndMs,
        },
        matchCount: 0,
      });
    }
  }

  return candidates;
}
