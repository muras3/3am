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
} from "3am-core";
import { generateEvidencePlan, generateEvidenceQuery, formatMetricFact, formatLogFact, formatTraceFact } from "3am-diagnosis";
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

type ExplanatoryTerm = {
  definition: string;
  canonical: string;
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

// ── Phase 3: Numbered option resolution ─────────────────────────

/**
 * Extracts numbered options from a clarification question text.
 * Matches patterns like "1. option text", "1) option text", "1: option text"
 */
function extractNumberedOptions(clarificationText: string): Map<number, string> {
  const options = new Map<number, string>();
  const lines = clarificationText.split(/\n/);
  for (const line of lines) {
    const match = /^\s*(\d+)[.):\s]+(.+)/.exec(line.trim());
    if (match) {
      const num = parseInt(match[1]!, 10);
      const text = match[2]!.trim();
      if (num > 0 && num <= 20 && text.length > 0) {
        options.set(num, text);
      }
    }
  }
  return options;
}

/**
 * Resolves numbered references in a user reply against clarification options.
 * "1" -> first option, "1と2" / "1 and 2" / "(1),(2)" -> both options joined.
 * Returns null if the reply doesn't match a number pattern.
 */
function resolveNumberedReply(
  reply: string,
  clarificationText: string,
): string | null {
  const options = extractNumberedOptions(clarificationText);
  if (options.size === 0) return null;

  // Match pure number references: "1", "1と2", "1 and 2", "(1)と(2)", "1,2,3"
  const trimmed = reply.trim();
  // Use alternation for multi-char separators; reject bare "1 2" or "1and2" without proper delimiters
  const numberPattern = /^[\s(]*\d+[\s)]*(?:(?:\s*(?:,|、|と|\band\b)\s*)[\s(]*\d+[\s)]*)*$/i;
  if (!numberPattern.test(trimmed)) return null;

  // Extract all numbers from the reply
  const numbers: number[] = [];
  const numRegex = /(\d+)/g;
  let numMatch: RegExpExecArray | null;
  while ((numMatch = numRegex.exec(trimmed)) !== null) {
    numbers.push(parseInt(numMatch[1]!, 10));
  }

  if (numbers.length === 0) return null;

  // Check all referenced numbers exist in options
  const resolved: string[] = [];
  for (const num of numbers) {
    const option = options.get(num);
    if (!option) return null; // Number doesn't match any option
    resolved.push(option);
  }

  return resolved.join("; ");
}

// ── Phase 4: Meta-speech (frustration/off-topic) detection ──────

const FRUSTRATION_PATTERNS_EN = [
  /^just answer/i,
  /\bstop asking\b/i,
  /\bquit asking\b/i,
  /\b(are you (stupid|dumb|broken|crazy|insane|nuts))\b/i,
  /^(wtf|wth|omg|ffs)$/i,
  /^(useless|pointless|whatever)$/i,
  /\bwaste of time\b/i,
  /\b(i (already|just) (said|told|answered|explained))\b/i,
  /\bread my (question|message|input)\b/i,
  /^(no|yes|ok|okay|sure|fine)$/i,
];

const FRUSTRATION_PATTERNS_JA = [
  /答え(て|ろ|てくれ|なさい)/,
  /(いかれ|おかしい|壊れ|バカ|アホ|ダメ)/,
  /(意味ない|使えない|役に立たない|無駄)/,
  /(もう(いい|やめ)|いい加減)/,
  /(さっき(言った|答えた|書いた))/,
  /(ちゃんと(読め|見て|聞いて))/,
  /^(はい|いいえ|うん|ううん|まあ|別に)$/,
];

function detectFrustration(question: string): boolean {
  const trimmed = question.trim();
  if (trimmed.length === 0) return false;

  for (const pattern of FRUSTRATION_PATTERNS_EN) {
    if (pattern.test(trimmed)) return true;
  }
  for (const pattern of FRUSTRATION_PATTERNS_JA) {
    if (pattern.test(trimmed)) return true;
  }
  return false;
}

function localizeMetaSpeechResponse(locale: "en" | "ja"): string {
  return locale === "ja"
    ? "すみません。質問を別の言い方で聞いていただけますか？例: 「root cause は何か」「最初に何をすべきか」「メトリクスに異常はあるか」"
    : "I apologize. Could you rephrase your question? For example: \"What is the root cause?\", \"What should I do first?\", or \"Are the metrics abnormal?\"";
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

  if (intent.kind === "action" && incident.diagnosisResult) {
    return {
      kind: "inference",
      text: locale === "ja"
        ? `いま取るべき最小アクションは、${incident.diagnosisResult.recommendation.immediate_action}`
        : `The minimum next action is ${incident.diagnosisResult.recommendation.immediate_action}`,
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
  if (intent.kind === "action") {
    return locale === "ja"
      ? `このアクションを優先する理由は、${incident.diagnosisResult.recommendation.action_rationale_short}`
      : `That action is prioritized because ${incident.diagnosisResult.recommendation.action_rationale_short}`;
  }
  return locale === "ja"
    ? `この並びは、${incident.diagnosisResult.summary.root_cause_hypothesis} という既存 diagnosis と整合しています。`
    : `That pattern is consistent with the existing diagnosis: ${incident.diagnosisResult.summary.root_cause_hypothesis}`;
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
      aliases: ["span", "spans", "スパン"],
      canonical: locale === "ja" ? "span" : "span",
      definitionJa: "span は、トレースの中の1区間で、特定の処理や依存先呼び出しの実行時間と結果を表します。",
      definitionEn: "A span is one timed unit within a trace, representing a specific operation or dependency call.",
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
    {
      aliases: ["worker pool", "workerpool", "ワーカープール"],
      canonical: locale === "ja" ? "ワーカープール" : "worker pool",
      definitionJa: "ワーカープールは、同時に処理を実行できる worker の枠です。枠を使い切ると新しい処理は待たされます。",
      definitionEn: "A worker pool is the fixed set of workers that can process requests concurrently. Once all workers are busy, new work has to wait.",
      preferredSurfaces: ["metrics", "traces", "logs"],
    },
    {
      aliases: ["rate limit", "rate-limit", "レート制限", "レートリミット"],
      canonical: locale === "ja" ? "レート制限" : "rate limit",
      definitionJa: "レート制限は、依存先が一定時間あたりのリクエスト数を超えないように上限をかける仕組みです。",
      definitionEn: "A rate limit is a cap that prevents clients from sending more than an allowed number of requests over a period of time.",
      preferredSurfaces: ["logs", "metrics", "traces"],
    },
    {
      aliases: ["retry", "retries", "再試行", "リトライ"],
      canonical: locale === "ja" ? "再試行" : "retry",
      definitionJa: "再試行は、失敗した処理をすぐ諦めず、もう一度実行する動きです。",
      definitionEn: "A retry is another attempt to perform a failed operation instead of giving up immediately.",
      preferredSurfaces: ["logs", "traces", "metrics"],
    },
    {
      aliases: ["circuit breaker", "circuit-breaker", "サーキットブレーカー"],
      canonical: locale === "ja" ? "サーキットブレーカー" : "circuit breaker",
      definitionJa: "サーキットブレーカーは、依存先の失敗が続くと呼び出しを一時的に止めて、障害の連鎖を防ぐ制御です。",
      definitionEn: "A circuit breaker temporarily stops calls to a failing dependency so repeated failures do not cascade through the system.",
      preferredSurfaces: ["logs", "metrics", "traces"],
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
  incident: Incident,
  evidence: EvidenceResponse,
  retrieved: RetrievedEvidence[],
  locale: "en" | "ja",
): EvidenceQueryResponse {
  const refs = retrieved.slice(0, 2).map((entry) => entry.ref);
  const primary = retrieved[0];
  const rootCause = incident.diagnosisResult?.summary.root_cause_hypothesis;
  const context = locale === "ja"
    ? `このインシデントでは、${term.canonical} は ${rootCause ?? "現在の障害の説明"} を理解するための文脈として使われています。`
    : `In this incident, ${term.canonical} is relevant because it helps explain ${rootCause ?? "the current failure pattern"}.`;

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

function buildMissingLogsAnswer(
  question: string,
  incident: Incident,
  evidence: EvidenceResponse,
  retrieved: RetrievedEvidence[],
  locale: "en" | "ja",
): EvidenceQueryResponse {
  const absenceClaim = evidence.surfaces.logs.claims.find((claim) => claim.type === "absence");
  const primaryTrace = retrieved.find((entry) => entry.surface === "traces") ?? retrieved[0];
  const evidenceRefs = [
    ...(absenceClaim ? [{
      kind: "absence" as const,
      id: absenceClaim.id,
    }] : []),
    ...(primaryTrace ? [primaryTrace.ref] : []),
  ];

  const segments: EvidenceQueryResponse["segments"] = [];
  if (absenceClaim) {
    segments.push({
      id: "seg_missing_logs_1",
      kind: "fact",
      text: locale === "ja"
        ? `${absenceClaim.label} に対応する失敗ログは、現在のインシデント窓では観測されていない。`
        : `The current incident window does not contain matching failure logs for ${absenceClaim.label}.`,
      evidenceRefs: [{ kind: "absence", id: absenceClaim.id }],
    });
  }

  segments.push({
    id: "seg_missing_logs_2",
    kind: "unknown",
    text: locale === "ja"
      ? "いま分かるのは「ログが無い」ことまでで、依存先がログを出す前に失敗したのか、収集経路が欠けたのかはまだ断定できない。"
      : "The evidence currently proves the logs are absent, but it does not yet distinguish between a pre-log failure and a collection gap.",
    evidenceRefs: evidenceRefs.length > 0 ? evidenceRefs : retrieved.slice(0, 2).map((entry) => entry.ref),
  });

  if (incident.diagnosisResult) {
    segments.push({
      id: "seg_missing_logs_3",
      kind: "inference",
      text: locale === "ja"
        ? "まずは最初の 500 を返した span と、その依存先のログ収集設定を確認するのが最短。"
        : "The shortest next step is to inspect the first 500 span and the logging path for the implicated dependency.",
      evidenceRefs: evidenceRefs.length > 0 ? evidenceRefs : retrieved.slice(0, 2).map((entry) => entry.ref),
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
  // For secondary diversity, skip absence entries when the intent is not about logs.
  // Absence entries ("0 entries matching [healthcheck]...") are misleading for trace/metrics/general questions.
  const isLogFocused = intent.kind === "logs";
  const secondary = retrieved.find(
    (entry) =>
      entry.ref.id !== primary?.ref.id &&
      entry.surface !== primary?.surface &&
      (isLogFocused || entry.ref.kind !== "absence"),
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
    // When primary/secondary are both absent, fall back to non-absence entries so the
    // inference segment does not cite phantom "0 entries matching…" absence evidence.
    const inferenceRefs = evidenceRefs.length > 0
      ? evidenceRefs
      : retrieved.filter((item) => isLogFocused || item.ref.kind !== "absence").slice(0, 2).map((item) => item.ref);
    segments.push({
      id: "seg_inference_1",
      kind: "inference",
      text: ensureSentence(inferenceTail),
      evidenceRefs: inferenceRefs.length > 0 ? inferenceRefs : retrieved.slice(0, 2).map((item) => item.ref),
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

export async function buildEvidenceQueryAnswer(
  incident: Incident,
  telemetryStore: TelemetryStoreDriver,
  question: string,
  isFollowup: boolean,
  locale: "en" | "ja" = "en",
  history: EvidenceConversationTurn[] = [],
  isSystemFollowup = false,
  replyToClarification?: { originalQuestion: string; clarificationText: string },
  clarificationChainLength = 0,
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

  if (/^(hi|hello|hey|こんにちは|こんばんは|おはよう)/i.test(question.trim())) {
    return buildDeterministicNoAnswer(
      question,
      curatedEvidence,
      localizeNoAnswerForGreeting(locale),
    );
  }

  // Phase 4: Detect frustration/meta-speech
  // Skip frustration detection when replying to a clarification — "yes", "no", "ok"
  // are valid clarification replies, not frustration.
  if (!replyToClarification && detectFrustration(question)) {
    return buildDeterministicNoAnswer(
      question,
      curatedEvidence,
      localizeMetaSpeechResponse(locale),
    );
  }

  // Phase 3: Resolve numbered references when replying to clarification
  let effectiveQuestionInput = question;
  if (replyToClarification) {
    const resolved = resolveNumberedReply(question, replyToClarification.clarificationText);
    if (resolved) {
      // Combine original question context with resolved answer
      effectiveQuestionInput = `${replyToClarification.originalQuestion} — ${resolved}`;
    } else {
      // User typed a free-text answer; combine with original question
      effectiveQuestionInput = `${replyToClarification.originalQuestion} (${question})`;
    }
  }

  const catalog = buildEvidenceCatalog(curatedEvidence, locale);
  const planningIntent: IntentProfile = { kind: "general", preferredSurfaces: ["traces", "metrics", "logs"] };
  const planningCandidates = retrieveEvidence(effectiveQuestionInput, catalog, planningIntent).slice(0, 8);
  const explanatoryTerm = detectExplanatoryTerm(effectiveQuestionInput, locale);
  if (explanatoryTerm) {
    return buildExplanatoryAnswer(
      question,
      explanatoryTerm,
      incident,
      curatedEvidence,
      planningCandidates,
      locale,
    );
  }

  let effectiveQuestion = effectiveQuestionInput;
  let intent: IntentProfile = planningIntent;
  let answerMode: "answer" | "action" | "missing_evidence" = "answer";

  // Phase 5: Force answer mode if clarification chain is too long (>= 2)
  const forceBestEffort = clarificationChainLength >= 2 || isSystemFollowup;

  try {
    const plan = await generateEvidencePlan(
      {
        question: effectiveQuestionInput,
        isSystemFollowup: forceBestEffort,
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

    if (plan.mode === "clarification" && !forceBestEffort) {
      return {
        question,
        status: "clarification",
        clarificationQuestion: plan.clarificationQuestion,
        segments: [],
        evidenceSummary: summarizeEvidence(curatedEvidence.surfaces),
        followups: buildFollowups(planningCandidates, curatedEvidence, question, locale),
      };
    }

    // When forceBestEffort is true and the planner still chose clarification,
    // treat the rewritten question as an "answer" mode — never surface clarification.
    effectiveQuestion = plan.rewrittenQuestion;
    answerMode = plan.mode === "clarification" ? "answer" : plan.mode;
    intent = intentFromMode(answerMode);
    intent.preferredSurfaces = plan.preferredSurfaces;
  } catch {
    if (/^(hi|hello|hey|こんにちは|こんばんは|おはよう)/i.test(question.trim())) {
      return buildDeterministicNoAnswer(
        question,
        curatedEvidence,
        localizeNoAnswerForGreeting(locale),
      );
    }
  }

  const retrieved = retrieveEvidence(effectiveQuestion, catalog, intent);
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
      },
      {
        model: EVIDENCE_QUERY_MODEL,
        locale,
        allowSubprocessProviders: false,
        allowLocalHttpProviders: false,
      },
    );

    return {
      ...generated,
      evidenceSummary: summarizeEvidence(curatedEvidence.surfaces),
      followups: buildFollowups(retrieved, curatedEvidence, question, locale),
    };
  } catch {
    if (answerMode === "missing_evidence") {
      return buildMissingLogsAnswer(question, incident, curatedEvidence, retrieved, locale);
    }
    return buildFallbackAnswer(question, incident, curatedEvidence, retrieved, intent, locale);
  }
}
