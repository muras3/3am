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
import { classifyDiagnosisState } from "./diagnosis-state.js";
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

type QueryIntent =
  | "metrics"
  | "logs"
  | "traces"
  | "root_cause"
  | "greeting"
  | "general";

type IntentProfile = {
  kind: QueryIntent;
  preferredSurfaces: Array<"traces" | "metrics" | "logs">;
};

function determineDiagnosisState(incident: Incident): DiagnosisState {
  return classifyDiagnosisState(incident);
}

function tokenize(input: string): string[] {
  const normalized = input.toLowerCase();
  const asciiTokens = normalized
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3);
  const phraseTokens = [
    "metrics",
    "metric",
    "logs",
    "log",
    "trace",
    "traces",
    "root cause",
    "cause",
    "why",
    "原因",
    "根本原因",
    "メトリクス",
    "ログ",
    "トレース",
    "異常",
    "問題",
    "なぜ",
  ].filter((token) => normalized.includes(token.toLowerCase()));
  return [...new Set([...asciiTokens, ...phraseTokens])];
}

function ensureSentence(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  return /[.!?。]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const match = /^[\s\S]*?[.!?。](?:\s|$)/.exec(trimmed);
  return ensureSentence((match?.[0] ?? trimmed).trim());
}

function localizeNoAnswerForGreeting(locale: "en" | "ja"): string {
  return locale === "ja"
    ? "このインシデントについて、トレース・メトリクス・ログ・原因を聞いて。"
    : "Ask about traces, metrics, logs, or the diagnosed cause for this incident.";
}

function buildDirectAnswer(
  intent: IntentProfile,
  locale: "en" | "ja",
  incident: Incident,
  primary?: RetrievedEvidence,
): { kind: "fact" | "inference"; text: string } | null {
  if (intent.kind === "greeting") return null;

  if (intent.kind === "root_cause" && incident.diagnosisResult) {
    return {
      kind: "inference",
      text: locale === "ja"
        ? `現時点では、${incident.diagnosisResult.summary.root_cause_hypothesis}`
        : `Current best explanation: ${incident.diagnosisResult.summary.root_cause_hypothesis}`,
    };
  }

  if (intent.kind === "metrics") {
    return {
      kind: "fact",
      text: locale === "ja"
        ? "はい。メトリクスでは明確な異常があります。"
        : "Yes. The metrics show a clear anomaly.",
    };
  }

  if (intent.kind === "logs") {
    return {
      kind: "fact",
      text: locale === "ja"
        ? "はい。ログにも異常があります。"
        : "Yes. The logs also show an abnormal pattern.",
    };
  }

  if (intent.kind === "traces") {
    return {
      kind: "fact",
      text: locale === "ja"
        ? "はい。失敗経路はトレースで確認できます。"
        : "Yes. The failing path is visible in traces.",
    };
  }

  if (primary) {
    return {
      kind: "fact",
      text: locale === "ja"
        ? "はい。いまの evidence で直接確認できる異常があります。"
        : "Yes. The current evidence shows a directly observable issue.",
    };
  }

  return null;
}

function buildInferenceTail(
  intent: IntentProfile,
  locale: "en" | "ja",
  incident: Incident,
): string | null {
  if (!incident.diagnosisResult) return null;
  if (intent.kind === "root_cause") {
    return locale === "ja"
      ? "この説明は既存の diagnosis と、いま取得できている traces / metrics / logs の並びに一致しています。"
      : "That explanation matches the existing diagnosis and the currently retrieved traces, metrics, and logs.";
  }
  return locale === "ja"
    ? `この並びは、${incident.diagnosisResult.summary.root_cause_hypothesis} という既存 diagnosis と整合しています。`
    : `That pattern is consistent with the existing diagnosis: ${incident.diagnosisResult.summary.root_cause_hypothesis}`;
}

function classifyQuestionIntent(question: string): IntentProfile {
  const lower = question.toLowerCase();
  if (/^(hi|hello|hey|こんにちは|こんばんは|おはよう)/i.test(question.trim())) {
    return { kind: "greeting", preferredSurfaces: [] };
  }
  if (/(metric|metrics|throughput|latency|error rate|spike|メトリクス|指標|スループット|レイテンシ|遅延)/i.test(lower)) {
    return { kind: "metrics", preferredSurfaces: ["metrics", "traces", "logs"] };
  }
  if (/(log|logs|retry|backoff|message|ログ|メッセージ|再試行|バックオフ)/i.test(lower)) {
    return { kind: "logs", preferredSurfaces: ["logs", "traces", "metrics"] };
  }
  if (/(trace|traces|span|route|path|trace path|トレース|スパン|経路|ルート|パス)/i.test(lower)) {
    return { kind: "traces", preferredSurfaces: ["traces", "logs", "metrics"] };
  }
  if (/(root cause|cause|why|what caused|原因|根本原因|なぜ)/i.test(lower)) {
    return { kind: "root_cause", preferredSurfaces: ["metrics", "logs", "traces"] };
  }
  return { kind: "general", preferredSurfaces: ["traces", "metrics", "logs"] };
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
      summary: ensureSentence(
        `Trace ${trace.route} span ${span.name} returned` +
          ((span.attributes["http.response.status_code"] ?? span.attributes["http.status_code"]) !== undefined
            ? ` httpStatus=${String(span.attributes["http.response.status_code"] ?? span.attributes["http.status_code"])}`
            : ` status=${span.status}`) +
          ` with durationMs=${span.durationMs}`,
      ),
      score: 0,
    })),
  );

  const metrics = evidence.surfaces.metrics.hypotheses.map((group) => ({
    ref: { kind: "metric_group" as const, id: group.id },
    surface: "metrics" as const,
    summary: ensureSentence(
      `Metric group ${group.id} indicates ${group.claim} Verdict=${group.verdict}. ` +
      `Observed metrics: ${group.metrics.map((m) => `${m.name} observed ${m.value} versus expected ${m.expected}`).join("; ")}`,
    ),
    score: 0,
  }));

  const logs = evidence.surfaces.logs.claims.map((claim) => ({
    ref: {
      kind: claim.type === "absence" ? "absence" as const : "log_cluster" as const,
      id: claim.id,
    },
    surface: "logs" as const,
    summary: ensureSentence(
      `Log evidence ${claim.label} of type ${claim.type} appeared ${claim.count} times.` +
      (claim.entries[0]?.body ? ` Sample log: ${claim.entries[0].body}.` : "") +
      (claim.explanation ? ` Explanation: ${claim.explanation}.` : ""),
    ),
    score: 0,
  }));

  return [...traces, ...metrics, ...logs];
}

function retrieveEvidence(
  question: string,
  catalog: RetrievedEvidence[],
  intent: IntentProfile,
): RetrievedEvidence[] {
  const tokens = new Set(tokenize(question));
  const boosted = catalog.map((entry, index) => {
    const haystack = `${entry.summary} ${entry.ref.id} ${entry.ref.kind}`.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (haystack.includes(token)) score += 3;
    }
    const surfacePriority = intent.preferredSurfaces.indexOf(entry.surface);
    if (surfacePriority !== -1) {
      score += 8 - surfacePriority * 2;
    }
    if (entry.ref.kind === "span" && /trace|span|path|route/.test(question.toLowerCase())) score += 2;
    if (entry.ref.kind === "metric_group" && /metric|rate|latency|error|throughput|spike/.test(question.toLowerCase())) score += 2;
    if ((entry.ref.kind === "log_cluster" || entry.ref.kind === "absence") && /log|missing|retry|backoff|error/.test(question.toLowerCase())) score += 2;
    if (intent.kind === "root_cause" && entry.surface !== "traces") score += 1;
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
  intent: IntentProfile,
  locale: "en" | "ja",
): EvidenceQueryResponse {
  if (intent.kind === "greeting") {
    return buildDeterministicNoAnswer(
      question,
      evidence,
      localizeNoAnswerForGreeting(locale),
    );
  }

  const segments: EvidenceQueryResponse["segments"] = [];
  const primary = retrieved.find((entry) => intent.preferredSurfaces.includes(entry.surface)) ?? retrieved[0];
  const secondary = retrieved.find(
    (entry) => entry.ref.id !== primary?.ref.id && entry.surface !== primary?.surface,
  );
  const direct = buildDirectAnswer(intent, locale, incident, primary);

  if (direct && (primary || secondary)) {
    segments.push({
      id: "seg_answer_1",
      kind: direct.kind,
      text: ensureSentence(direct.text),
      evidenceRefs: [primary, secondary]
        .filter((entry): entry is RetrievedEvidence => Boolean(entry))
        .slice(0, 2)
        .map((entry) => entry.ref),
    });
  }

  if (primary) {
    segments.push({
      id: "seg_fact_1",
      kind: "fact",
      text: firstSentence(primary.summary),
      evidenceRefs: [primary.ref],
    });
  }

  if (intent.kind === "metrics") {
    const metric = retrieved.find((entry) => entry.surface === "metrics");
    if (metric && metric.ref.id !== primary?.ref.id) {
      segments.push({
        id: "seg_fact_2",
        kind: "fact",
        text: firstSentence(metric.summary),
        evidenceRefs: [metric.ref],
      });
    }
  } else if (intent.kind === "logs") {
    const log = retrieved.find((entry) => entry.surface === "logs");
    if (log && log.ref.id !== primary?.ref.id) {
      segments.push({
        id: "seg_fact_2",
        kind: "fact",
        text: firstSentence(log.summary),
        evidenceRefs: [log.ref],
      });
    }
  } else if (secondary) {
    segments.push({
      id: "seg_fact_2",
      kind: "fact",
      text: firstSentence(secondary.summary),
      evidenceRefs: [secondary.ref],
    });
  }

  const inferenceTail = buildInferenceTail(intent, locale, incident);
  if (inferenceTail && retrieved.length > 0 && intent.kind !== "root_cause") {
    const evidenceRefs = [primary, secondary]
      .filter((entry): entry is RetrievedEvidence => Boolean(entry))
      .map((entry) => entry.ref);
    segments.push({
      id: "seg_inference_1",
      kind: "inference",
      text: ensureSentence(inferenceTail),
      evidenceRefs: evidenceRefs.length > 0 ? evidenceRefs : retrieved.slice(0, 2).map((item) => item.ref),
    });
  } else if (inferenceTail && intent.kind === "root_cause" && primary) {
    segments.push({
      id: "seg_inference_1",
      kind: "inference",
      text: ensureSentence(inferenceTail),
      evidenceRefs: [primary.ref],
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
    followups: buildFollowups(retrieved, evidence, question, locale),
  };
}

function followupText(
  key:
    | "metrics_window"
    | "log_cluster"
    | "trace_path"
    | "missing_signal"
    | "inspect_span"
    | "abnormal_metric"
    | "symptom_log",
  locale: "en" | "ja",
): string {
  if (locale === "ja") {
    switch (key) {
      case "metrics_window":
        return "同じ時間帯の異常はメトリクスでも出ている？";
      case "log_cluster":
        return "そのドリフトに対応するログクラスタはどれ？";
      case "trace_path":
        return "この失敗が最初に出たトレース経路はどれ？";
      case "missing_signal":
        return "欠けているはずの回復シグナルは何？";
      case "inspect_span":
        return "最初に見るべき span はどれ？";
      case "abnormal_metric":
        return "いちばん異常な metric group はどれ？";
      case "symptom_log":
        return "症状を最もよく説明するログクラスタはどれ？";
    }
  }

  switch (key) {
    case "metrics_window":
      return "Do the metrics show the same failure window?";
    case "log_cluster":
      return "Which log cluster lines up with that drift?";
    case "trace_path":
      return "Which trace path first shows this failure?";
    case "missing_signal":
      return "What expected resilience signal is still missing?";
    case "inspect_span":
      return "Which span should I inspect first?";
    case "abnormal_metric":
      return "Which metric group is most abnormal?";
    case "symptom_log":
      return "Which log cluster best explains the symptom?";
  }
}

function buildFollowups(
  retrieved: RetrievedEvidence[],
  evidence: EvidenceResponse,
  question: string,
  locale: "en" | "ja" = "en",
): Followup[] {
  const lowerQuestion = question.toLowerCase();
  const surfaceSeen = new Set(retrieved.map((entry) => entry.surface));
  const followups: Followup[] = [];

  if (surfaceSeen.has("traces") && !lowerQuestion.includes("metric")) {
    followups.push({
      question: followupText("metrics_window", locale),
      targetEvidenceKinds: ["metrics"],
    });
  }
  if (surfaceSeen.has("metrics") && !lowerQuestion.includes("log")) {
    followups.push({
      question: followupText("log_cluster", locale),
      targetEvidenceKinds: ["logs"],
    });
  }
  if (surfaceSeen.has("logs") && !lowerQuestion.includes("trace")) {
    followups.push({
      question: followupText("trace_path", locale),
      targetEvidenceKinds: ["traces"],
    });
  }

  const hasAbsence = evidence.surfaces.logs.claims.some((claim) => claim.type === "absence");
  if (hasAbsence && !lowerQuestion.includes("missing")) {
    followups.push({
      question: followupText("missing_signal", locale),
      targetEvidenceKinds: ["logs"],
    });
  }

  if (followups.length === 0) {
    if (evidence.surfaces.traces.observed.length > 0) {
      followups.push({ question: followupText("inspect_span", locale), targetEvidenceKinds: ["traces"] });
    }
    if (evidence.surfaces.metrics.hypotheses.length > 0) {
      followups.push({ question: followupText("abnormal_metric", locale), targetEvidenceKinds: ["metrics"] });
    }
    if (evidence.surfaces.logs.claims.length > 0) {
      followups.push({ question: followupText("symptom_log", locale), targetEvidenceKinds: ["logs"] });
    }
  }

  return followups.slice(0, 4);
}

export async function buildEvidenceQueryAnswer(
  incident: Incident,
  telemetryStore: TelemetryStoreDriver,
  question: string,
  _isFollowup: boolean,
  locale: "en" | "ja" = "en",
): Promise<EvidenceQueryResponse> {
  const diagnosisState = determineDiagnosisState(incident);
  const curatedEvidence = await buildCuratedEvidence(incident, telemetryStore);
  const intent = classifyQuestionIntent(question);

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
  const retrieved = retrieveEvidence(question, catalog, intent);
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
        intent: intent.kind,
        preferredSurfaces: intent.preferredSurfaces,
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
      { model: EVIDENCE_QUERY_MODEL, locale },
    );

    return {
      ...generated,
      evidenceSummary: summarizeEvidence(curatedEvidence.surfaces),
      followups: buildFollowups(retrieved, curatedEvidence, question, locale),
    };
  } catch {
    return buildFallbackAnswer(question, incident, curatedEvidence, retrieved, intent, locale);
  }
}
