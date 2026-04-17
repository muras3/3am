/**
 * evidence-query.ts — Domain logic for POST /api/incidents/:id/evidence/query.
 *
 * LLM-first synthesis (see absolute rule in CLAUDE.md):
 *   detection  : code-side (diagnosis_status, evidence_status, absence_input)
 *   synthesis  : always LLM (no deterministic template output)
 *   repair     : strip invalid refs + bounded retry inside generate-*
 *   safety net : ONE final deterministic no-answer when the LLM cannot be
 *                reached (provider-down equivalent), routed through a single
 *                call site at the end of buildEvidenceQueryAnswer.
 */

import type {
  EvidenceQueryRef,
  EvidenceQueryResponse,
  EvidenceResponse,
  Followup,
} from "3am-core";
import {
  generateEvidencePlan,
  generateEvidenceQueryWithMeta,
  formatMetricFact,
  formatLogFact,
  formatTraceFact,
  type EvidenceQueryAbsenceInput,
} from "3am-diagnosis";
import type { Incident } from "../storage/interface.js";
import { classifyDiagnosisState } from "./diagnosis-state.js";
import type { TelemetryStoreDriver } from "../telemetry/interface.js";
import { buildCuratedEvidence } from "./curated-evidence.js";
import type { EvidenceConversationTurn, IntentProfile } from "./evidence-conversation.js";

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

function intentFromMode(mode: "answer" | "action" | "missing_evidence"): IntentProfile {
  if (mode === "action") {
    return { kind: "action", preferredSurfaces: ["traces", "logs", "metrics"] };
  }
  if (mode === "missing_evidence") {
    return { kind: "logs", preferredSurfaces: ["logs", "traces", "metrics"] };
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

function buildEvidenceCatalog(
  evidence: EvidenceResponse,
  locale: "en" | "ja" = "en",
): RetrievedEvidence[] {
  const traces = evidence.surfaces.traces.observed.flatMap((trace) =>
    trace.spans.map((span) => ({
      ref: { kind: "span" as const, id: `${trace.traceId}:${span.spanId}` },
      surface: "traces" as const,
      summary: ensureSentence(
        formatTraceFact(
          {
            route: trace.route,
            spanName: span.name,
            httpStatus: (span.attributes["http.response.status_code"] ?? span.attributes["http.status_code"]) as string | number | undefined,
            spanStatus: span.status,
            durationMs: span.durationMs,
          },
          locale,
        ),
      ),
      score: 0,
    })),
  );

  const metrics = evidence.surfaces.metrics.hypotheses.map((group) => ({
    ref: { kind: "metric_group" as const, id: group.id },
    surface: "metrics" as const,
    summary: ensureSentence(
      formatMetricFact(
        {
          id: group.id,
          claim: group.claim,
          verdict: group.verdict,
          metrics: group.metrics.map((m) => ({ name: m.name, value: m.value, expected: m.expected })),
        },
        locale,
      ),
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
      formatLogFact(
        {
          label: claim.label,
          type: claim.type,
          count: claim.count,
          sampleBody: claim.entries[0]?.body,
          explanation: claim.explanation,
        },
        locale,
      ),
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
  const lowerQuestion = question.toLowerCase();
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
    if (entry.ref.kind === "span" && /trace|span|path|route|トレース|パス/.test(lowerQuestion)) score += 15;
    if (entry.ref.kind === "metric_group" && /metric|rate|latency|error rate|throughput|spike|メトリクス|レイテンシ/.test(lowerQuestion)) score += 15;
    if ((entry.ref.kind === "log_cluster" || entry.ref.kind === "absence") && /\blog\b|logs|missing log|retry|backoff|ログ|エラーログ/.test(lowerQuestion)) score += 15;
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

/**
 * The single deterministic no-answer builder. Per CLAUDE.md this is allowed
 * ONLY as the provider-down / retries-exhausted safety net. The function
 * itself is retained, but there is exactly ONE call site in this file (the
 * final return in buildEvidenceQueryAnswer).
 */
function buildDeterministicNoAnswer(
  question: string,
  evidence: EvidenceResponse,
  reason: string,
  locale: "en" | "ja" = "en",
): EvidenceQueryResponse {
  return {
    question,
    status: "no_answer",
    segments: [],
    evidenceSummary: summarizeEvidence(evidence.surfaces),
    followups: buildFollowups([], evidence, question, locale),
    noAnswerReason: reason,
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
        return "障害期間中の同じ時間帯の異常はメトリクスでも出ている？";
      case "log_cluster":
        return "障害期間中のそのドリフトに対応するログクラスタはどれ？";
      case "trace_path":
        return "障害期間の中で、この失敗が最初に出たトレース経路はどれ？";
      case "missing_signal":
        return "障害期間中に欠けているはずの回復シグナルは何？";
      case "inspect_span":
        return "障害期間中の最初に見るべき span はどれ？";
      case "abnormal_metric":
        return "障害期間中でいちばん異常な metric group はどれ？";
      case "symptom_log":
        return "障害期間中の症状を最もよく説明するログクラスタはどれ？";
    }
  }

  switch (key) {
    case "metrics_window":
      return "Do the metrics show the same failure window during the incident?";
    case "log_cluster":
      return "Which log cluster during the incident lines up with that drift?";
    case "trace_path":
      return "Within the incident window, which trace path first shows this failure?";
    case "missing_signal":
      return "What expected resilience signal is still missing during the incident?";
    case "inspect_span":
      return "Within the incident window, which span should I inspect first?";
    case "abnormal_metric":
      return "Within the incident window, which metric group is most abnormal?";
    case "symptom_log":
      return "Within the incident window, which log cluster best explains the symptom?";
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

function detectAbsenceInput(
  question: string,
  evidence: EvidenceResponse,
  answerMode: "answer" | "action" | "missing_evidence",
): EvidenceQueryAbsenceInput | undefined {
  if (answerMode !== "missing_evidence") return undefined;
  const absenceClaim = evidence.surfaces.logs.claims.find((claim) => claim.type === "absence");
  if (!absenceClaim) return undefined;
  // If the user explicitly asks why the signal hasn't arrived yet we hint
  // "not-yet-available"; otherwise treat it as "no-record-found" (collector
  // never saw it). "no-supporting-evidence" requires a contradicting signal
  // which is a narrower detection job left for future work.
  const lowered = question.toLowerCase();
  const claimType: EvidenceQueryAbsenceInput["claimType"] =
    /まだ|yet|pending|処理中|遅れ|collecting|まだ来て/.test(lowered)
      ? "not-yet-available"
      : "no-record-found";
  return {
    claimId: absenceClaim.id,
    label: absenceClaim.label,
    claimType,
  };
}

function classifyEvidenceStatus(
  retrieved: RetrievedEvidence[],
): "empty" | "sparse" | "dense" {
  if (retrieved.length === 0) return "empty";
  if (retrieved.length <= 2) return "sparse";
  return "dense";
}

export async function buildEvidenceQueryAnswer(
  incident: Incident,
  telemetryStore: TelemetryStoreDriver,
  question: string,
  isFollowup: boolean,
  locale: "en" | "ja" = "en",
  history: EvidenceConversationTurn[] = [],
  isSystemFollowup = false,
  replyToClarification?: { originalQuestion: string; clarificationText: string },
): Promise<EvidenceQueryResponse> {
  const diagnosisState = determineDiagnosisState(incident);
  const curatedEvidence = await buildCuratedEvidence(incident, telemetryStore);

  // When replying to a clarification, enrich the question with the original context
  // so the LLM can understand what the user is responding to
  let effectiveQuestionInput = question;
  if (replyToClarification) {
    effectiveQuestionInput = `${replyToClarification.originalQuestion} (${question})`;
  }

  void isFollowup; // preserved for future callers; not used on this path.

  const catalog = buildEvidenceCatalog(curatedEvidence, locale);
  const planningIntent: IntentProfile = { kind: "general", preferredSurfaces: ["traces", "metrics", "logs"] };
  const planningCandidates = retrieveEvidence(effectiveQuestionInput, catalog, planningIntent).slice(0, 8);

  let effectiveQuestion = effectiveQuestionInput;
  let intent: IntentProfile = planningIntent;
  let answerMode: "answer" | "action" | "missing_evidence" = "answer";

  // Planner is still allowed to clarify or pick an answer mode. It is a pure
  // routing step; synthesis is the LLM call below.
  if (diagnosisState === "ready") {
    try {
      const plan = await generateEvidencePlan(
        {
          question: effectiveQuestionInput,
          isSystemFollowup,
          history,
          diagnosis: incident.diagnosisResult
            ? {
                whatHappened: incident.diagnosisResult.summary.what_happened,
                rootCauseHypothesis: incident.diagnosisResult.summary.root_cause_hypothesis,
                immediateAction: incident.diagnosisResult.recommendation.immediate_action,
                causalChain: incident.diagnosisResult.reasoning.causal_chain.map((step) => step.title),
              }
            : null,
          evidence: planningCandidates.map(({ ref, surface, summary }) => ({ ref, surface, summary })),
        },
        {
          model: EVIDENCE_QUERY_MODEL,
          locale,
          allowSubprocessProviders: false,
          allowLocalHttpProviders: false,
        },
      );

      if (plan.mode === "clarification" && !isSystemFollowup) {
        return {
          question,
          status: "clarification",
          clarificationQuestion: plan.clarificationQuestion,
          segments: [],
          evidenceSummary: summarizeEvidence(curatedEvidence.surfaces),
          followups: buildFollowups(planningCandidates, curatedEvidence, question, locale),
        };
      }

      // When isSystemFollowup is true and the planner still chose clarification,
      // treat the rewritten question as an "answer" mode — never surface clarification.
      effectiveQuestion = plan.rewrittenQuestion;
      answerMode = plan.mode === "clarification" ? "answer" : plan.mode;
      intent = intentFromMode(answerMode);
      intent.preferredSurfaces = plan.preferredSurfaces;
    } catch {
      // Planner failure is non-fatal — fall through to default routing and
      // let the synthesis LLM handle the question directly.
    }
  }

  const retrieved = retrieveEvidence(effectiveQuestion, catalog, intent);
  const evidenceStatus = classifyEvidenceStatus(retrieved);
  const absenceInput = detectAbsenceInput(effectiveQuestion, curatedEvidence, answerMode);

  // ── Synthesis (LLM-first). Even pending/unavailable diagnosis routes here.
  try {
    const { response: generated, meta } = await generateEvidenceQueryWithMeta(
      {
        question: effectiveQuestionInput,
        answerMode,
        history,
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
        diagnosisStatus: diagnosisState,
        evidenceStatus,
        absenceInput,
        locale,
      },
      {
        model: EVIDENCE_QUERY_MODEL,
        locale,
        allowSubprocessProviders: false,
        allowLocalHttpProviders: false,
      },
    );

    if (meta.retryCount > 0 || meta.repairedRefCount > 0) {
      // Operator-visible observability for the repair loop; no schema changes.
      process.stderr.write(
        `[evidence-query] synthesis meta retryCount=${meta.retryCount} repairedRefCount=${meta.repairedRefCount}\n`,
      );
    }

    return {
      ...generated,
      evidenceSummary: summarizeEvidence(curatedEvidence.surfaces),
      followups: buildFollowups(retrieved, curatedEvidence, question, locale),
    };
  } catch (err) {
    process.stderr.write(
      `[evidence-query] LLM synthesis failed after retries (${err instanceof Error ? err.message : String(err)}); returning safety-net no-answer.\n`,
    );
    // ── SOLE deterministic safety-net call site. Reached only when:
    //   - the LLM provider is unreachable, OR
    //   - every retry produced unusable output (invalid refs that could not
    //     be repaired + strict-reminder + narrowed refs all failed).
    // Per CLAUDE.md this is the allowed "provider-down-equivalent" escape.
    return buildDeterministicNoAnswer(
      question,
      curatedEvidence,
      locale === "ja"
        ? "LLMによる回答生成がリトライ後も失敗しました。エビデンスは左側のパネルで確認できますが、今回は根拠のある回答を生成できませんでした。"
        : "LLM synthesis failed after retries. The evidence surfaces are available on the left, but a grounded answer could not be generated this time.",
      locale,
    );
  }
}
