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
import type { Incident } from "../storage/interface.js";
import { classifyDiagnosisState } from "./diagnosis-state.js";
import type { TelemetryStoreDriver } from "../telemetry/interface.js";
import { buildCuratedEvidence } from "./curated-evidence.js";

type DiagnosisState = "ready" | "pending" | "unavailable";
type QueryIntent = "greeting" | "root_cause" | "metrics" | "logs" | "action" | "timeline" | "general";

type RetrievedEvidence = {
  ref: EvidenceQueryRef;
  surface: "traces" | "metrics" | "logs";
  summary: string;
  score: number;
};

type EvidenceQuerySegment = EvidenceQueryResponse["segments"][number];

function determineDiagnosisState(incident: Incident): DiagnosisState {
  return classifyDiagnosisState(incident);
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

function includesAny(input: string, patterns: string[]): boolean {
  return patterns.some((pattern) => input.includes(pattern));
}

function classifyIntent(question: string): QueryIntent {
  const normalized = question.trim().toLowerCase();
  if (!normalized) return "general";
  if (includesAny(normalized, ["こんにちは", "こんばんは", "おはよう", "hello", "hi ", "hey"])) return "greeting";
  if (includesAny(normalized, ["根本原因", "root cause", "原因", "why"])) return "root_cause";
  if (includesAny(normalized, ["メトリクス", "metric", "metrics", "latency", "error rate", "queue", "worker_pool", "throughput"])) return "metrics";
  if (includesAny(normalized, ["ログ", "log", "logs", "warn", "error", "missing", "absence"])) return "logs";
  if (includesAny(normalized, ["何をすべき", "どうすれば", "mitigation", "next action", "action", "remediation"])) return "action";
  if (includesAny(normalized, ["いつ", "timeline", "start", "started", "time"])) return "timeline";
  return "general";
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
        ((span.attributes["http.response.status_code"] ?? span.attributes["http.status_code"]) !== undefined
          ? ` httpStatus=${String(span.attributes["http.response.status_code"] ?? span.attributes["http.status_code"])}` : ""),
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
  const intent = classifyIntent(question);
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
    if (intent === "metrics" && entry.surface === "metrics") score += 6;
    if (intent === "logs" && entry.surface === "logs") score += 6;
    if (intent === "timeline" && entry.surface === "traces") score += 4;
    if (intent === "root_cause" && (entry.surface === "traces" || entry.surface === "logs")) score += 3;
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

function firstTraceRef(evidence: EvidenceResponse): EvidenceQueryRef | null {
  const trace = evidence.surfaces.traces.observed[0];
  const span = trace?.spans[0];
  return trace && span ? { kind: "span", id: `${trace.traceId}:${span.spanId}` } : null;
}

function buildTraceFact(evidence: EvidenceResponse): EvidenceQuerySegment | null {
  const trace = evidence.surfaces.traces.observed[0];
  const span = trace?.spans[0];
  if (!trace || !span) return null;
  return {
    id: "seg_fact_trace_1",
    kind: "fact",
    text: `${trace.route} returned httpStatus=${trace.status} with ${trace.durationMs}ms duration on the observed failure path.`,
    evidenceRefs: [{ kind: "span", id: `${trace.traceId}:${span.spanId}` }],
  };
}

function buildMetricFact(evidence: EvidenceResponse): EvidenceQuerySegment | null {
  const group = evidence.surfaces.metrics.hypotheses[0];
  const metric = group?.metrics[0];
  if (!group || !metric) return null;
  return {
    id: "seg_fact_metric_1",
    kind: "fact",
    text: `${group.claim} was abnormal in metrics: ${metric.name} observed ${metric.value} versus expected ${metric.expected}.`,
    evidenceRefs: [{ kind: "metric_group", id: group.id }],
  };
}

function buildMetricFactFromRetrieved(retrieved: RetrievedEvidence[]): EvidenceQuerySegment | null {
  const metric = retrieved.find((entry) => entry.ref.kind === "metric_group");
  if (!metric) return null;
  return {
    id: "seg_fact_metric_1",
    kind: "fact",
    text: `${metric.summary}. This was abnormal in metrics.`,
    evidenceRefs: [metric.ref],
  };
}

function buildLogFact(evidence: EvidenceResponse): EvidenceQuerySegment | null {
  const claim = evidence.surfaces.logs.claims[0];
  if (!claim) return null;
  if (claim.type === "absence") {
    return {
      id: "seg_fact_log_absence_1",
      kind: "fact",
      text: `${claim.label}. ${claim.explanation ?? "That expected signal was not observed during the incident."}`,
      evidenceRefs: [{ kind: "absence", id: claim.id }],
    };
  }
  const sample = claim.entries[0]?.body;
  return {
    id: "seg_fact_log_1",
    kind: "fact",
    text: `${claim.label} produced ${claim.count} entries${sample ? `, for example: ${sample}.` : "."}`,
    evidenceRefs: [{ kind: "log_cluster", id: claim.id }],
  };
}

function buildInference(
  incident: Incident,
  evidenceRefs: EvidenceQueryRef[],
  id = "seg_inference_1",
): EvidenceQuerySegment | null {
  if (!incident.diagnosisResult || evidenceRefs.length === 0) return null;
  return {
    id,
    kind: "inference",
    text: incident.diagnosisResult.summary.root_cause_hypothesis,
    evidenceRefs,
  };
}

function buildGreetingNoAnswer(
  question: string,
  evidence: EvidenceResponse,
  incident: Incident,
): EvidenceQueryResponse {
  const fallbackRef = firstTraceRef(evidence) ?? { kind: "log_cluster", id: `${incident.incidentId}:greeting` };
  return {
    question,
    status: "no_answer",
    segments: [{
      id: "seg_unknown_greeting",
      kind: "unknown",
      text: "Please ask about the incident, its evidence, the likely cause, or the next action to take.",
      evidenceRefs: [fallbackRef],
    }],
    evidenceSummary: summarizeEvidence(evidence.surfaces),
    followups: buildFollowups([], evidence, "root cause"),
    noAnswerReason: "Please ask an incident-related question.",
  };
}

function buildActionAnswer(
  question: string,
  incident: Incident,
  evidence: EvidenceResponse,
): EvidenceQueryResponse {
  const ref = firstTraceRef(evidence) ?? { kind: "log_cluster", id: `${incident.incidentId}:action` };
  return {
    question,
    status: "answered",
    segments: [
      {
        id: "seg_fact_action_1",
        kind: "fact",
        text: incident.diagnosisResult?.recommendation.immediate_action ?? "Use the evidence below to decide the next mitigation step.",
        evidenceRefs: [ref],
      },
      {
        id: "seg_inference_action_1",
        kind: "inference",
        text: incident.diagnosisResult?.recommendation.action_rationale_short ?? "This action reduces the current blast radius first.",
        evidenceRefs: [ref],
      },
    ],
    evidenceSummary: summarizeEvidence(evidence.surfaces),
    followups: buildFollowups([], evidence, question),
  };
}

function buildTimelineAnswer(
  question: string,
  incident: Incident,
  evidence: EvidenceResponse,
): EvidenceQueryResponse {
  const ref = firstTraceRef(evidence) ?? { kind: "log_cluster", id: `${incident.incidentId}:timeline` };
  return {
    question,
    status: "answered",
    segments: [{
      id: "seg_fact_timeline_1",
      kind: "fact",
      text: `The visible incident window runs from ${incident.packet.window.detect} to ${incident.packet.window.end}.`,
      evidenceRefs: [ref],
    }],
    evidenceSummary: summarizeEvidence(evidence.surfaces),
    followups: buildFollowups([], evidence, question),
  };
}

function buildIntentAwareAnswer(
  question: string,
  incident: Incident,
  evidence: EvidenceResponse,
  retrieved: RetrievedEvidence[],
): EvidenceQueryResponse {
  const intent = classifyIntent(question);
  if (intent === "greeting") return buildGreetingNoAnswer(question, evidence, incident);
  if (intent === "action") return buildActionAnswer(question, incident, evidence);
  if (intent === "timeline") return buildTimelineAnswer(question, incident, evidence);

  const segments: EvidenceQuerySegment[] = [];
  if (intent === "metrics") {
    const metricFact = buildMetricFact(evidence) ?? buildMetricFactFromRetrieved(retrieved);
    if (!metricFact) {
      return buildDeterministicNoAnswer(
        question,
        evidence,
        "The current curated metrics do not contain enough linked evidence to answer this metrics-specific question responsibly.",
      );
    }
    segments.push(metricFact);
  } else if (intent === "logs") {
    const logFact = buildLogFact(evidence);
    if (logFact) segments.push(logFact);
    const absence = evidence.surfaces.logs.claims.find((claim) => claim.type === "absence");
    if (absence) {
      segments.push({
        id: "seg_fact_log_2",
        kind: "fact",
        text: `${absence.label}. ${absence.explanation ?? "That missing signal narrows the likely failure mode."}`,
        evidenceRefs: [{ kind: "absence", id: absence.id }],
      });
    }
  } else {
    const traceFact = buildTraceFact(evidence);
    if (traceFact) segments.push(traceFact);
    const metricFact = buildMetricFact(evidence);
    if (metricFact) segments.push(metricFact);
  }

  const inferenceRefs = segments.flatMap((segment) => segment.evidenceRefs).slice(0, 2);
  const inference = buildInference(incident, inferenceRefs, intent === "root_cause" ? "seg_inference_root_1" : "seg_inference_support_1");
  if (inference) segments.push(inference);

  if (segments.length === 0) {
    return buildDeterministicNoAnswer(
      question,
      evidence,
      "The current curated evidence does not contain enough linked material to answer this question responsibly.",
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

  return buildIntentAwareAnswer(question, incident, curatedEvidence, retrieved);
}
