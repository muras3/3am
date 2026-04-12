import type {
  ConsoleNarrative,
  DiagnosisResult,
  EvidenceQueryResponse,
  EvidenceResponse,
  IncidentPacket,
  ReasoningStructure,
} from "3am-core";
import {
  callModelMessages,
  diagnose,
  formatLogFact,
  formatMetricFact,
  formatTraceFact,
  generateEvidencePlan,
  generateEvidenceQuery,
  generateConsoleNarrative,
  wrapUserMessage,
  type ProviderName,
} from "3am-diagnosis";
import { resolveProviderModel } from "./provider-model.js";

export type ManualExecutionOptions = {
  receiverUrl: string;
  incidentId: string;
  authToken?: string;
  provider?: ProviderName;
  model?: string;
  locale?: "en" | "ja";
};

type ExtendedIncidentPayload = {
  incidentId: string;
  diagnosisResult?: DiagnosisResult;
};

type EvidenceConversationTurn = {
  role: "user" | "assistant";
  content: string;
};

type IntentProfile = {
  kind: "metrics" | "logs" | "traces" | "root_cause" | "action" | "greeting" | "general";
  preferredSurfaces: Array<"traces" | "metrics" | "logs">;
};

type RetrievedEvidence = {
  ref: { kind: "span" | "metric_group" | "log_cluster" | "absence"; id: string };
  surface: "traces" | "metrics" | "logs";
  summary: string;
  score: number;
};

type ExplanatoryTerm = {
  definition: string;
  canonical: string;
  preferredSurfaces: Array<"traces" | "metrics" | "logs">;
};

function authHeaders(authToken?: string): Record<string, string> {
  return authToken
    ? { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
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

function summarizeEvidence(evidence: EvidenceResponse["surfaces"]) {
  return {
    traces: evidence.traces.observed.length,
    metrics: evidence.metrics.hypotheses.length,
    logs: evidence.logs.claims.length,
  };
}

function buildEvidenceCatalog(evidence: EvidenceResponse, locale: "en" | "ja" = "en"): RetrievedEvidence[] {
  const traces = evidence.surfaces.traces.observed.flatMap((trace) =>
    trace.spans.map((span) => ({
      ref: { kind: "span" as const, id: `${trace.traceId}:${span.spanId}` },
      surface: "traces" as const,
      summary: ensureSentence(
        formatTraceFact(
          {
            route: trace.route,
            spanName: span.name,
            httpStatus: span.attributes["http.response.status_code"] as string | number | undefined,
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

function buildDirectAnswer(
  intent: IntentProfile,
  locale: "en" | "ja",
  diagnosisResult: DiagnosisResult,
  primary?: RetrievedEvidence,
): { kind: "fact" | "inference"; text: string } | null {
  if (intent.kind === "greeting") return null;

  if (intent.kind === "root_cause") {
    return {
      kind: "inference",
      text: locale === "ja"
        ? `現時点では、${diagnosisResult.summary.root_cause_hypothesis}`
        : `Current best explanation: ${diagnosisResult.summary.root_cause_hypothesis}`,
    };
  }

  if (intent.kind === "action") {
    return {
      kind: "inference",
      text: locale === "ja"
        ? `いま取るべき最小アクションは、${diagnosisResult.recommendation.immediate_action}`
        : `The minimum next action is ${diagnosisResult.recommendation.immediate_action}`,
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
  diagnosisResult: DiagnosisResult,
): string | null {
  if (intent.kind === "root_cause") {
    return locale === "ja"
      ? "この説明は既存の diagnosis と、いま取得できている traces / metrics / logs の並びに一致しています。"
      : "That explanation matches the existing diagnosis and the currently retrieved traces, metrics, and logs.";
  }
  if (intent.kind === "action") {
    return locale === "ja"
      ? `このアクションを優先する理由は、${diagnosisResult.recommendation.action_rationale_short}`
      : `That action is prioritized because ${diagnosisResult.recommendation.action_rationale_short}`;
  }
  return locale === "ja"
    ? `この並びは、${diagnosisResult.summary.root_cause_hypothesis} という既存 diagnosis と整合しています。`
    : `That pattern is consistent with the existing diagnosis: ${diagnosisResult.summary.root_cause_hypothesis}`;
}

function detectExplanatoryTerm(question: string, locale: "en" | "ja"): ExplanatoryTerm | null {
  const lower = question.toLowerCase();
  const asksDefinition = /what is|what's|define|meaning|とは|って何|ってなんですか|何ですか|なんですか|どういう意味/.test(lower);
  if (!asksDefinition) return null;

  const terms: Array<{ aliases: string[]; canonical: string; definitionJa: string; definitionEn: string; preferredSurfaces: Array<"traces" | "metrics" | "logs"> }> = [
    {
      aliases: ["trace", "traces", "トレース"],
      canonical: locale === "ja" ? "トレース" : "trace",
      definitionJa: "トレースは、1つのリクエストや処理がシステム内をどう通ったかを、サービス間の流れとして追える記録です。",
      definitionEn: "A trace is a record of how a single request or operation moved through the system across services.",
      preferredSurfaces: ["traces", "logs", "metrics"],
    },
    {
      aliases: ["metric", "metrics", "メトリクス", "指標"],
      canonical: locale === "ja" ? "メトリクス" : "metric",
      definitionJa: "メトリクスは、エラー率や遅延のような挙動を数値で継続的に観測する指標です。",
      definitionEn: "Metrics are continuous numeric measurements such as error rate or latency that describe system behavior over time.",
      preferredSurfaces: ["metrics", "traces", "logs"],
    },
    {
      aliases: ["log", "logs", "ログ"],
      canonical: locale === "ja" ? "ログ" : "log",
      definitionJa: "ログは、実行中に起きた出来事やエラーをテキストとして残した記録です。",
      definitionEn: "Logs are text records of events, warnings, and errors emitted while the system runs.",
      preferredSurfaces: ["logs", "traces", "metrics"],
    },
    {
      aliases: ["backoff", "バックオフ"],
      canonical: locale === "ja" ? "バックオフ" : "backoff",
      definitionJa: "バックオフは、失敗した依存先への再試行のたびに待ち時間を伸ばして、相手を連続で叩き続けないようにする制御です。",
      definitionEn: "Backoff is a retry strategy that waits progressively longer between attempts so a failing dependency is not hammered continuously.",
      preferredSurfaces: ["logs", "metrics", "traces"],
    },
    {
      aliases: ["queue", "キュー", "待ち行列"],
      canonical: locale === "ja" ? "キュー" : "queue",
      definitionJa: "キューは、すぐ処理できない仕事やリクエストが、処理待ちとして溜まっている状態です。",
      definitionEn: "A queue is work or requests waiting to be processed because the system cannot handle them immediately.",
      preferredSurfaces: ["metrics", "traces", "logs"],
    },
  ];

  const term = terms.find((entry) =>
    entry.aliases.some((alias) => lower.includes(alias.toLowerCase())),
  );
  if (!term) return null;

  return {
    canonical: term.canonical,
    definition: locale === "ja" ? term.definitionJa : term.definitionEn,
    preferredSurfaces: term.preferredSurfaces,
  };
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

function buildExplanatoryAnswer(
  question: string,
  term: ExplanatoryTerm,
  diagnosisResult: DiagnosisResult,
  evidence: EvidenceResponse,
  retrieved: RetrievedEvidence[],
  locale: "en" | "ja",
): EvidenceQueryResponse {
  const refs = retrieved.slice(0, 2).map((entry) => entry.ref);
  const primary = retrieved[0];
  const context = locale === "ja"
    ? `このインシデントでは、${term.canonical} は ${diagnosisResult.summary.root_cause_hypothesis} を理解するための文脈として使われています。`
    : `In this incident, ${term.canonical} is relevant because it helps explain ${diagnosisResult.summary.root_cause_hypothesis}.`;

  const segments: EvidenceQueryResponse["segments"] = [
    {
      id: "seg_explanation_1",
      kind: "inference",
      text: ensureSentence(term.definition),
      evidenceRefs: refs.length > 0 ? refs : [{ kind: "metric_group", id: "mgroup:0" }],
    },
    {
      id: "seg_explanation_2",
      kind: "inference",
      text: ensureSentence(context),
      evidenceRefs: refs.length > 0 ? refs : [{ kind: "metric_group", id: "mgroup:0" }],
    },
  ];

  if (primary) {
    segments.push({
      id: "seg_explanation_3",
      kind: "fact",
      text: firstSentence(primary.summary),
      evidenceRefs: [primary.ref],
    });
  }

  return {
    question,
    status: "answered",
    segments,
    evidenceSummary: summarizeEvidence(evidence.surfaces),
    followups: buildFollowups(retrieved, evidence, question, locale),
  };
}

function buildFallbackAnswer(
  question: string,
  diagnosisResult: DiagnosisResult,
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
  const direct = buildDirectAnswer(intent, locale, diagnosisResult, primary);

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

  if (secondary) {
    segments.push({
      id: "seg_fact_2",
      kind: "fact",
      text: firstSentence(secondary.summary),
      evidenceRefs: [secondary.ref],
    });
  }

  const inferenceTail = buildInferenceTail(intent, locale, diagnosisResult);
  if (inferenceTail && retrieved.length > 0) {
    const evidenceRefs = [primary, secondary]
      .filter((entry): entry is RetrievedEvidence => Boolean(entry))
      .map((entry) => entry.ref);
    segments.push({
      id: "seg_inference_1",
      kind: "inference",
      text: ensureSentence(inferenceTail),
      evidenceRefs: evidenceRefs.length > 0 ? evidenceRefs : retrieved.slice(0, 2).map((item) => item.ref),
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
): Array<{ question: string; targetEvidenceKinds: Array<"traces" | "metrics" | "logs"> }> {
  const lowerQuestion = question.toLowerCase();
  const surfaceSeen = new Set(retrieved.map((entry) => entry.surface));
  const followups: Array<{ question: string; targetEvidenceKinds: Array<"traces" | "metrics" | "logs"> }> = [];

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

async function buildManualEvidenceQueryAnswer(
  diagnosisResult: DiagnosisResult,
  evidence: EvidenceResponse,
  question: string,
  history: EvidenceConversationTurn[],
  options: { provider?: ProviderName; model?: string; locale: "en" | "ja" },
): Promise<EvidenceQueryResponse> {
  if (/^(hi|hello|hey|こんにちは|こんばんは|おはよう)/i.test(question.trim())) {
    return buildDeterministicNoAnswer(
      question,
      evidence,
      localizeNoAnswerForGreeting(options.locale),
    );
  }

  const catalog = buildEvidenceCatalog(evidence, options.locale);
  const planningIntent: IntentProfile = { kind: "general", preferredSurfaces: ["traces", "metrics", "logs"] };
  const planningCandidates = retrieveEvidence(question, catalog, planningIntent).slice(0, 8);
  const explanatoryTerm = detectExplanatoryTerm(question, options.locale);
  if (explanatoryTerm) {
    return buildExplanatoryAnswer(
      question,
      explanatoryTerm,
      diagnosisResult,
      evidence,
      planningCandidates,
      options.locale,
    );
  }

  let effectiveQuestion = question;
  let intent: IntentProfile = planningIntent;
  let answerMode: "answer" | "action" | "missing_evidence" = "answer";

  try {
    const plan = await generateEvidencePlan(
      {
        question,
        history,
        diagnosis: {
          whatHappened: diagnosisResult.summary.what_happened,
          rootCauseHypothesis: diagnosisResult.summary.root_cause_hypothesis,
          immediateAction: diagnosisResult.recommendation.immediate_action,
          causalChain: diagnosisResult.reasoning.causal_chain.map((step) => step.title),
        },
        evidence: planningCandidates.map(({ ref, surface, summary }) => ({ ref, surface, summary })),
      },
      {
        provider: options.provider,
        model: options.model,
        locale: options.locale,
      },
    );

    if (plan.mode === "clarification") {
      return {
        question,
        status: "clarification",
        clarificationQuestion: plan.clarificationQuestion,
        segments: [],
        evidenceSummary: summarizeEvidence(evidence.surfaces),
        followups: buildFollowups(planningCandidates, evidence, question, options.locale),
      };
    }

    effectiveQuestion = plan.rewrittenQuestion;
    answerMode = plan.mode;
    intent = intentFromMode(plan.mode);
    intent.preferredSurfaces = plan.preferredSurfaces;
  } catch {
    // Fall back to deterministic routing below.
  }

  const retrieved = retrieveEvidence(effectiveQuestion, catalog, intent);
  if (retrieved.length === 0) {
    return buildDeterministicNoAnswer(
      question,
      evidence,
      "The current curated evidence does not contain enough linked material to answer this question responsibly.",
    );
  }

  try {
    const generated = await generateEvidenceQuery(
      {
        question,
        answerMode,
        history,
        intent: intent.kind,
        preferredSurfaces: intent.preferredSurfaces,
        diagnosis: {
          whatHappened: diagnosisResult.summary.what_happened,
          rootCauseHypothesis: diagnosisResult.summary.root_cause_hypothesis,
          immediateAction: diagnosisResult.recommendation.immediate_action,
          causalChain: diagnosisResult.reasoning.causal_chain.map((step) => step.title),
        },
        evidence: retrieved.map(({ ref, surface, summary }) => ({ ref, surface, summary })),
      },
      {
        provider: options.provider,
        model: options.model,
        locale: options.locale,
      },
    );

    return {
      ...generated,
      evidenceSummary: summarizeEvidence(evidence.surfaces),
      followups: buildFollowups(retrieved, evidence, question, options.locale),
    };
  } catch {
    return buildFallbackAnswer(question, diagnosisResult, evidence, retrieved, intent, options.locale);
  }
}

function buildChatSystemPrompt(dr: DiagnosisResult, locale?: "en" | "ja"): string {
  const chain = dr.reasoning.causal_chain.map((step: DiagnosisResult["reasoning"]["causal_chain"][number]) => step.title).join(" -> ");
  const jaInstruction = locale === "ja"
    ? "\n\nRespond in Japanese. Use concise, operator-actionable language."
    : "";
  return (
    "You are an incident responder assistant. The engineer is investigating an active incident.\n\n" +
    `Incident summary: ${dr.summary.what_happened}\n` +
    `Root cause: ${dr.summary.root_cause_hypothesis}\n` +
    `Recommended action: ${dr.recommendation.immediate_action}\n` +
    `Causal chain: ${chain}\n` +
    `Confidence: ${dr.confidence.confidence_assessment}\n` +
    `Known uncertainty: ${dr.confidence.uncertainty}\n\n` +
    "Answer concisely in 1-3 sentences. If you infer anything, label it as a hypothesis." +
    jaInstruction
  );
}

export async function runManualDiagnosis(options: ManualExecutionOptions): Promise<{
  diagnosis: DiagnosisResult;
  narrative: ConsoleNarrative | undefined;
}> {
  const headers = authHeaders(options.authToken);
  const packet = await fetchJson<IncidentPacket>(
    `${options.receiverUrl}/api/incidents/${encodeURIComponent(options.incidentId)}/packet`,
    { headers },
  );
  const reasoning = await fetchJson<ReasoningStructure>(
    `${options.receiverUrl}/api/incidents/${encodeURIComponent(options.incidentId)}/reasoning-structure`,
    { headers },
  );
  const localeResponse = await fetchJson<{ locale?: "en" | "ja" }>(
    `${options.receiverUrl}/api/settings/locale`,
    { headers },
  ).catch(() => ({ locale: "en" as const }));
  const locale = options.locale ?? localeResponse.locale ?? "en";
  const model = resolveProviderModel(options.provider, options.model);

  const diagnosis = await diagnose(packet, {
    provider: options.provider,
    model,
    locale,
  });

  // Stage 2: narrative generation — graceful degradation.
  // A NarrativeValidationError or any other narrative failure must NOT cause
  // the diagnose command to fail. Stage 1 result is always returned.
  let narrative: ConsoleNarrative | undefined;
  try {
    narrative = await generateConsoleNarrative(diagnosis, reasoning, {
      provider: options.provider,
      model,
      locale,
    });
  } catch (narrativeErr) {
    console.warn(
      `[manual-execution] narrative generation failed (stage 1 result preserved): ${String(narrativeErr)}`,
    );
  }

  await fetchJson<{ status: string }>(
    `${options.receiverUrl}/api/diagnosis/${encodeURIComponent(options.incidentId)}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(diagnosis),
    },
  );

  if (narrative) {
    await fetchJson<{ status: string }>(
      `${options.receiverUrl}/api/incidents/${encodeURIComponent(options.incidentId)}/console-narrative`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(narrative),
      },
    );
  }

  return { diagnosis, narrative };
}

export async function runManualChat(options: ManualExecutionOptions & {
  message: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  systemPrompt?: string;
}): Promise<{ reply: string }> {
  const headers = authHeaders(options.authToken);
  const model = resolveProviderModel(options.provider, options.model, "claude-haiku-4-5-20251001");

  let resolvedSystemPrompt: string;
  if (options.systemPrompt) {
    resolvedSystemPrompt = options.systemPrompt;
  } else {
    // Fallback: fetch the incident to build the system prompt locally.
    // This path is used when the caller (e.g. CLI direct invocation) does not
    // pre-build the prompt on the receiver side.
    const incident = await fetchJson<ExtendedIncidentPayload>(
      `${options.receiverUrl}/api/incidents/${encodeURIComponent(options.incidentId)}`,
      { headers },
    );
    if (!incident.diagnosisResult) {
      throw new Error("diagnosis is not available for this incident yet");
    }
    const localeResponse = await fetchJson<{ locale?: "en" | "ja" }>(
      `${options.receiverUrl}/api/settings/locale`,
      { headers },
    ).catch(() => ({ locale: "en" as const }));
    const locale = options.locale ?? localeResponse.locale ?? "en";
    resolvedSystemPrompt = buildChatSystemPrompt(incident.diagnosisResult, locale);
  }

  const reply = await callModelMessages(
    [
      { role: "system", content: resolvedSystemPrompt },
      ...options.history,
      { role: "user", content: wrapUserMessage(options.message) },
    ],
    {
      provider: options.provider,
      model,
      maxTokens: 512,
      temperature: 0.3,
    },
  );

  return { reply };
}

export async function runManualEvidenceQuery(options: ManualExecutionOptions & {
  question: string;
  history: EvidenceConversationTurn[];
  diagnosisResult?: DiagnosisResult;
  evidence?: EvidenceResponse;
}): Promise<EvidenceQueryResponse> {
  let diagnosisResult = options.diagnosisResult;
  let evidence = options.evidence;
  let locale = options.locale ?? "en";

  if (!diagnosisResult || !evidence) {
    // Fallback: fetch from receiver (CLI direct invocation)
    const headers = authHeaders(options.authToken);
    const [incident, fetchedEvidence, localeResponse] = await Promise.all([
      fetchJson<ExtendedIncidentPayload>(
        `${options.receiverUrl}/api/incidents/${encodeURIComponent(options.incidentId)}`,
        { headers },
      ),
      fetchJson<EvidenceResponse>(
        `${options.receiverUrl}/api/incidents/${encodeURIComponent(options.incidentId)}/evidence`,
        { headers },
      ),
      fetchJson<{ locale?: "en" | "ja" }>(
        `${options.receiverUrl}/api/settings/locale`,
        { headers },
      ).catch(() => ({ locale: "en" as const })),
    ]);

    if (!incident.diagnosisResult) {
      throw new Error("diagnosis is not available for this incident yet");
    }
    diagnosisResult = incident.diagnosisResult;
    evidence = fetchedEvidence;
    locale = options.locale ?? localeResponse.locale ?? "en";
  }

  const model = resolveProviderModel(options.provider, options.model, "claude-haiku-4-5-20251001");

  return buildManualEvidenceQueryAnswer(
    diagnosisResult,
    evidence,
    options.question,
    options.history,
    {
      provider: options.provider,
      model,
      locale,
    },
  );
}
