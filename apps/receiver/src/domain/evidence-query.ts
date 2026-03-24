/**
 * evidence-query.ts — Domain logic for POST /api/incidents/:id/evidence/query.
 *
 * Uses the curated evidence read model as the source of truth, performs a
 * lightweight retrieval pass, then generates a grounded single-turn answer.
 */

import type {
  EvidenceQueryRef,
  EvidenceQueryResponse,
  EvidenceResponse,
  Followup,
} from "@3amoncall/core";
import { generateEvidenceQuery } from "@3amoncall/diagnosis";
import type { Incident } from "../storage/interface.js";
import type { TelemetryStoreDriver } from "../telemetry/interface.js";
import { buildCuratedEvidence } from "./curated-evidence.js";

const EVIDENCE_QUERY_MODEL =
  process.env["EVIDENCE_QUERY_MODEL"] ?? "claude-haiku-4-5-20251001";

type DiagnosisState = "ready" | "pending" | "unavailable";

type RetrievedEvidence = {
  ref: EvidenceQueryRef;
  surface: "traces" | "metrics" | "logs";
  summary: string;
  score: number;
};

function determineDiagnosisState(incident: Incident): DiagnosisState {
  if (incident.diagnosisResult) return "ready";
  if (incident.diagnosisDispatchedAt) return "pending";
  return "unavailable";
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

function summarizeEvidence(evidence: EvidenceResponse["surfaces"]) {
  return {
    traces: evidence.traces.observed.length,
    metrics: evidence.metrics.hypotheses.length,
    logs: evidence.logs.claims.length,
  };
}

function buildEvidenceCatalog(evidence: EvidenceResponse): RetrievedEvidence[] {
  const traces = evidence.surfaces.traces.observed.flatMap((trace) =>
    trace.spans.map((span) => ({
      ref: { kind: "span" as const, id: `${trace.traceId}:${span.spanId}` },
      surface: "traces" as const,
      summary:
        `${trace.route} span ${span.name} status=${span.status} durationMs=${span.durationMs}` +
        (span.attributes["http.status_code"] !== undefined
          ? ` httpStatus=${String(span.attributes["http.status_code"])}` : ""),
      score: 0,
    })),
  );

  const metrics = evidence.surfaces.metrics.hypotheses.map((group) => ({
    ref: { kind: "metric_group" as const, id: group.id },
    surface: "metrics" as const,
    summary: `${group.claim}. verdict=${group.verdict}. metrics=${group.metrics.map((m) => m.name).join(", ")}`,
    score: 0,
  }));

  const logs = evidence.surfaces.logs.claims.map((claim) => ({
    ref: {
      kind: claim.type === "absence" ? "absence" as const : "log_cluster" as const,
      id: claim.id,
    },
    surface: "logs" as const,
    summary:
      `${claim.label}. type=${claim.type}. count=${claim.count}.` +
      (claim.entries[0]?.body ? ` sample=${claim.entries[0].body}` : "") +
      (claim.explanation ? ` explanation=${claim.explanation}` : ""),
    score: 0,
  }));

  return [...traces, ...metrics, ...logs];
}

function retrieveEvidence(question: string, catalog: RetrievedEvidence[]): RetrievedEvidence[] {
  const tokens = new Set(tokenize(question));
  const boosted = catalog.map((entry, index) => {
    const haystack = `${entry.summary} ${entry.ref.id} ${entry.ref.kind}`.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (haystack.includes(token)) score += 3;
    }
    if (entry.ref.kind === "span" && /trace|span|path|route/.test(question.toLowerCase())) score += 2;
    if (entry.ref.kind === "metric_group" && /metric|rate|latency|error|throughput|spike/.test(question.toLowerCase())) score += 2;
    if ((entry.ref.kind === "log_cluster" || entry.ref.kind === "absence") && /log|missing|retry|backoff|error/.test(question.toLowerCase())) score += 2;
    return { ...entry, score: score + Math.max(0, 1 - index * 0.01) };
  });

  const sorted = boosted
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const diverse: RetrievedEvidence[] = [];
  const seenKinds = new Set<string>();
  for (const entry of sorted) {
    if (diverse.length < 4 || !seenKinds.has(entry.ref.kind)) {
      diverse.push(entry);
      seenKinds.add(entry.ref.kind);
    }
  }

  return diverse.length > 0 ? diverse : catalog.slice(0, 4);
}

function buildDeterministicNoAnswer(
  question: string,
  evidence: EvidenceResponse,
  reason: string,
): EvidenceQueryResponse {
  return {
    question,
    status: "no_answer",
    segments: [],
    evidenceSummary: summarizeEvidence(evidence.surfaces),
    followups: buildFollowups([], evidence, question),
    noAnswerReason: reason,
  };
}

function buildFallbackAnswer(
  question: string,
  incident: Incident,
  evidence: EvidenceResponse,
  retrieved: RetrievedEvidence[],
): EvidenceQueryResponse {
  const segments: EvidenceQueryResponse["segments"] = [];

  const firstFact = retrieved[0];
  if (firstFact) {
    segments.push({
      id: "seg_fact_1",
      kind: "fact",
      text: firstFact.summary.split(".")[0] ?? firstFact.summary,
      evidenceRefs: [firstFact.ref],
    });
  }

  const secondFact = retrieved.find((item) => item.ref.kind !== firstFact?.ref.kind);
  if (secondFact) {
    segments.push({
      id: "seg_fact_2",
      kind: "fact",
      text: secondFact.summary.split(".")[0] ?? secondFact.summary,
      evidenceRefs: [secondFact.ref],
    });
  }

  if (incident.diagnosisResult && retrieved.length > 0) {
    segments.push({
      id: "seg_inference_1",
      kind: "inference",
      text: incident.diagnosisResult.summary.root_cause_hypothesis,
      evidenceRefs: retrieved.slice(0, 2).map((item) => item.ref),
    });
  }

  if (segments.length === 0) {
    return buildDeterministicNoAnswer(
      question,
      evidence,
      "The current curated evidence does not support a grounded answer yet.",
    );
  }

  return {
    question,
    status: "answered",
    segments,
    evidenceSummary: summarizeEvidence(evidence.surfaces),
    followups: buildFollowups(retrieved, evidence, question),
  };
}

function buildFollowups(
  retrieved: RetrievedEvidence[],
  evidence: EvidenceResponse,
  question: string,
): Followup[] {
  const lowerQuestion = question.toLowerCase();
  const surfaceSeen = new Set(retrieved.map((entry) => entry.surface));
  const followups: Followup[] = [];

  if (surfaceSeen.has("traces") && !lowerQuestion.includes("metric")) {
    followups.push({
      question: "Do the metrics show the same failure window?",
      targetEvidenceKinds: ["metrics"],
    });
  }
  if (surfaceSeen.has("metrics") && !lowerQuestion.includes("log")) {
    followups.push({
      question: "Which log cluster lines up with that drift?",
      targetEvidenceKinds: ["logs"],
    });
  }
  if (surfaceSeen.has("logs") && !lowerQuestion.includes("trace")) {
    followups.push({
      question: "Which trace path first shows this failure?",
      targetEvidenceKinds: ["traces"],
    });
  }

  const hasAbsence = evidence.surfaces.logs.claims.some((claim) => claim.type === "absence");
  if (hasAbsence && !lowerQuestion.includes("missing")) {
    followups.push({
      question: "What expected resilience signal is still missing?",
      targetEvidenceKinds: ["logs"],
    });
  }

  if (followups.length === 0) {
    if (evidence.surfaces.traces.observed.length > 0) {
      followups.push({ question: "Which span should I inspect first?", targetEvidenceKinds: ["traces"] });
    }
    if (evidence.surfaces.metrics.hypotheses.length > 0) {
      followups.push({ question: "Which metric group is most abnormal?", targetEvidenceKinds: ["metrics"] });
    }
    if (evidence.surfaces.logs.claims.length > 0) {
      followups.push({ question: "Which log cluster best explains the symptom?", targetEvidenceKinds: ["logs"] });
    }
  }

  return followups.slice(0, 4);
}

export async function buildEvidenceQueryAnswer(
  incident: Incident,
  telemetryStore: TelemetryStoreDriver,
  question: string,
  _isFollowup: boolean,
): Promise<EvidenceQueryResponse> {
  const diagnosisState = determineDiagnosisState(incident);
  const curatedEvidence = await buildCuratedEvidence(incident, telemetryStore);

  if (diagnosisState === "unavailable") {
    return buildDeterministicNoAnswer(
      question,
      curatedEvidence,
      "No diagnosis has been triggered for this incident, so the system will not guess beyond the curated evidence.",
    );
  }

  if (diagnosisState === "pending") {
    return buildDeterministicNoAnswer(
      question,
      curatedEvidence,
      "Diagnosis is still running. The curated evidence surfaces are available now, but the system is withholding a grounded answer until diagnosis is ready.",
    );
  }

  const catalog = buildEvidenceCatalog(curatedEvidence);
  const retrieved = retrieveEvidence(question, catalog);
  if (retrieved.length === 0) {
    return buildDeterministicNoAnswer(
      question,
      curatedEvidence,
      "The current curated evidence does not contain enough linked material to answer this question responsibly.",
    );
  }

  try {
    const generated = await generateEvidenceQuery(
      {
        question,
        diagnosis: incident.diagnosisResult
          ? {
              whatHappened: incident.diagnosisResult.summary.what_happened,
              rootCauseHypothesis: incident.diagnosisResult.summary.root_cause_hypothesis,
              immediateAction: incident.diagnosisResult.recommendation.immediate_action,
              causalChain: incident.diagnosisResult.reasoning.causal_chain.map((step) => step.title),
            }
          : null,
        evidence: retrieved.map(({ ref, surface, summary }) => ({ ref, surface, summary })),
      },
      { model: EVIDENCE_QUERY_MODEL },
    );

    return {
      ...generated,
      evidenceSummary: summarizeEvidence(curatedEvidence.surfaces),
      followups: buildFollowups(retrieved, curatedEvidence, question),
    };
  } catch {
    return buildFallbackAnswer(question, incident, curatedEvidence, retrieved);
  }
}
