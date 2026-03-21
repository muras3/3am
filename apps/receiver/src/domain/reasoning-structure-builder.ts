/**
 * reasoning-structure-builder.ts — builds ReasoningStructure for stage 2 narrative generation.
 *
 * Reuses existing selectors from incident-detail-extension (blast radius, evidence counts,
 * baseline) and absence-detector. Produces the deterministic context that diagnosis reads.
 */

import type { ReasoningStructure, ProofRef, BlastRadiusTarget, AbsenceCandidate } from "@3amoncall/core";
import type { TelemetryStoreDriver, TelemetrySpan, TelemetryLog } from "../telemetry/interface.js";
import { buildIncidentQueryFilter } from "../telemetry/interface.js";
import type { Incident, TelemetryScope, AnomalousSignal } from "../storage/interface.js";
import { computeBlastRadius } from "./blast-radius.js";

// ── Constants ─────────────────────────────────────────────────────────────

const MIN_BASELINE_WINDOW_MS = 5 * 60 * 1000;
const ABSENCE_PATTERNS = [
  { patternId: "no-retry", keywords: ["retry", "backoff", "circuit_breaker", "circuit-breaker"] },
  { patternId: "no-circuit-breaker", keywords: ["circuit", "breaker", "open state"] },
  { patternId: "no-fallback", keywords: ["fallback", "degraded mode", "serve stale"] },
] as const;

// ── Public API ────────────────────────────────────────────────────────────

export async function buildReasoningStructure(
  incident: Incident,
  telemetryStore: TelemetryStoreDriver,
): Promise<ReasoningStructure> {
  const { telemetryScope, anomalousSignals } = incident;
  const incidentFilter = buildIncidentQueryFilter(telemetryScope);

  const [
    { entries: blastEntries },
    spans,
    metrics,
    logs,
  ] = await Promise.all([
    computeBlastRadius(telemetryStore, telemetryScope),
    telemetryStore.querySpans(incidentFilter),
    telemetryStore.queryMetrics(incidentFilter),
    telemetryStore.queryLogs(incidentFilter),
  ]);

  // ── Evidence counts (canonical rule: unique traceId, raw row counts) ──
  const traceIds = new Set(spans.map((s) => s.traceId));
  const traceErrors = spans.filter(
    (s) =>
      (s.httpStatusCode !== undefined && s.httpStatusCode >= 500) ||
      s.spanStatusCode === 2 ||
      s.exceptionCount > 0,
  ).length;
  const logErrors = logs.filter(
    (l) => l.severity === "ERROR" || l.severity === "FATAL",
  ).length;

  // ── Blast radius → BlastRadiusTarget ──────────────────────────────────
  const blastRadius: BlastRadiusTarget[] = blastEntries.map((entry) => ({
    targetId: entry.targetId,
    label: entry.label,
    status: entry.status,
    impactValue: entry.impactValue,
    displayValue: entry.displayValue,
  }));

  // ── Proof refs ────────────────────────────────────────────────────────
  const proofRefs = buildProofRefs(spans, logs, anomalousSignals);

  // ── Absence candidates ────────────────────────────────────────────────
  const absenceCandidates = buildAbsenceCandidates(
    logs,
    anomalousSignals,
    telemetryScope,
  );

  // ── Timeline summary ──────────────────────────────────────────────────
  const primaryService = incident.packet.scope.primaryService;
  const crossServiceSignal = anomalousSignals.find(
    (s) => s.entity !== primaryService,
  );

  // ── Q&A context ───────────────────────────────────────────────────────
  const availableEvidenceKinds: ("traces" | "metrics" | "logs")[] = [];
  if (traceIds.size > 0) availableEvidenceKinds.push("traces");
  if (metrics.length > 0) availableEvidenceKinds.push("metrics");
  if (logs.length > 0) availableEvidenceKinds.push("logs");

  return {
    incidentId: incident.incidentId,
    evidenceCounts: {
      traces: traceIds.size,
      traceErrors,
      metrics: metrics.length,
      logs: logs.length,
      logErrors,
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

// ── Proof ref derivation ────────────────────────────────────────────────

function buildProofRefs(
  spans: TelemetrySpan[],
  logs: TelemetryLog[],
  anomalousSignals: AnomalousSignal[],
): ProofRef[] {
  const refs: ProofRef[] = [];

  // Trigger proof card — first error span as evidence
  const errorSpans = spans.filter(
    (s) =>
      (s.httpStatusCode !== undefined && s.httpStatusCode >= 500) ||
      s.httpStatusCode === 429 ||
      s.spanStatusCode === 2,
  );
  const triggerSpan = errorSpans[0];
  if (triggerSpan) {
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
  const hasDependencyFailure = anomalousSignals.some(
    (s) => s.signal.includes("429") || s.signal.includes("5"),
  );
  const retryLogs = logs.filter((l) =>
    /retry|backoff|circuit.?breaker/i.test(l.body),
  );
  if (hasDependencyFailure && retryLogs.length === 0) {
    refs.push({
      cardId: "design_gap",
      targetSurface: "logs",
      evidenceRefs: [],
      status: "inferred",
    });
  } else if (hasDependencyFailure && retryLogs.length > 0) {
    refs.push({
      cardId: "design_gap",
      targetSurface: "logs",
      evidenceRefs: retryLogs.slice(0, 3).map((l) => ({
        kind: "log" as const,
        id: `${l.service}:${l.timestamp}`,
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

  // Recovery proof card — look for recovery signals in logs
  const recoveryLogs = logs.filter((l) =>
    /recover|resolv|restored|healthy|back.?to.?normal/i.test(l.body),
  );
  refs.push({
    cardId: "recovery",
    targetSurface: "logs",
    evidenceRefs: recoveryLogs.slice(0, 3).map((l) => ({
      kind: "log" as const,
      id: `${l.service}:${l.timestamp}`,
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
  const hasDependencyFailure = anomalousSignals.some(
    (s) => s.signal.includes("429") || s.signal.includes("5"),
  );
  if (!hasDependencyFailure) return [];

  const candidates: AbsenceCandidate[] = [];

  for (const pattern of ABSENCE_PATTERNS) {
    const matchCount = logs.filter((l) =>
      pattern.keywords.some((kw) =>
        l.body.toLowerCase().includes(kw.toLowerCase()),
      ),
    ).length;

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
