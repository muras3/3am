import type {
  EvidenceQueryResponse,
  EvidenceResponse,
  Followup,
} from "@3am/core";

export type EvidenceConversationTurn = {
  role: "user" | "assistant";
  content: string;
};

export type QueryIntent =
  | "metrics"
  | "logs"
  | "traces"
  | "root_cause"
  | "action"
  | "greeting"
  | "general";

export type IntentProfile = {
  kind: QueryIntent;
  preferredSurfaces: Array<"traces" | "metrics" | "logs">;
};

export type ConversationPlan =
  | {
      kind: "clarification";
      question: string;
      clarificationQuestion: string;
      followups: Followup[];
    }
  | {
      kind: "grounded";
      question: string;
      effectiveQuestion: string;
      intent: IntentProfile;
    };

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function looksLikeGreeting(question: string): boolean {
  return /^(hi|hello|hey|こんにちは|こんばんは|おはよう)/i.test(question.trim());
}

function classifyStandaloneIntent(question: string): IntentProfile {
  const lower = question.toLowerCase();
  if (looksLikeGreeting(question)) {
    return { kind: "greeting", preferredSurfaces: [] };
  }
  if (/(next action|what should|do first|should we|mitigation|remediation|対応|初動|次のアクション|何をすべき|どうすべき|どうあるべき|あるべき)/i.test(lower)) {
    return { kind: "action", preferredSurfaces: ["traces", "logs", "metrics"] };
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

function isUnderspecified(question: string): boolean {
  const trimmed = normalize(question);
  if (!trimmed) return true;
  const explicitAsk = /(what happened|what failed|cause|root cause|why|trace|span|metric|log|next action|what should|do first|原因|根本原因|なぜ|トレース|スパン|メトリクス|ログ|次のアクション|とは|what is|define|meaning)/i.test(trimmed);
  if (explicitAsk) return false;
  return /(それ|これ|あれ|それって|じゃあ|then|so|that|it|they|what next|next\??$|why that|how so|どうしてそれ|何をすれば|どうあるべき)/i.test(trimmed);
}

function makeClarifyingFollowups(locale: "en" | "ja"): Followup[] {
  if (locale === "ja") {
    return [
      { question: "原因を知りたい", targetEvidenceKinds: ["traces", "metrics", "logs"] },
      { question: "今やるべきアクションを知りたい", targetEvidenceKinds: ["traces", "logs"] },
      { question: "ログが無い理由を知りたい", targetEvidenceKinds: ["logs"] },
      { question: "最初に見るべきトレースを知りたい", targetEvidenceKinds: ["traces"] },
    ];
  }
  return [
    { question: "What is the likely cause?", targetEvidenceKinds: ["traces", "metrics", "logs"] },
    { question: "What should I do first?", targetEvidenceKinds: ["traces", "logs"] },
    { question: "Why are logs missing?", targetEvidenceKinds: ["logs"] },
    { question: "Which trace should I inspect first?", targetEvidenceKinds: ["traces"] },
  ];
}

function makeClarificationQuestion(locale: "en" | "ja"): string {
  return locale === "ja"
    ? "何を知りたいかを一段具体化して。原因、今やるべきアクション、ログが無い理由、最初に見るトレース、のどれかで聞いて。"
    : "Be more specific. Ask about the likely cause, the next action, why logs are missing, or which trace to inspect first.";
}

function previousUserQuestion(history: EvidenceConversationTurn[]): string | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    if (turn?.role === "user" && turn.content.trim()) {
      return turn.content.trim();
    }
  }
  return null;
}

function previousAssistantAnswer(history: EvidenceConversationTurn[]): string | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    if (turn?.role === "assistant" && turn.content.trim()) {
      return turn.content.trim();
    }
  }
  return null;
}

function rewriteWithContext(
  question: string,
  history: EvidenceConversationTurn[],
): string {
  const previousUser = previousUserQuestion(history);
  const previousAssistant = previousAssistantAnswer(history);
  if (!previousUser && !previousAssistant) return question;
  if (previousUser && previousAssistant) {
    return `Previous user question: ${previousUser}\nPrevious assistant answer: ${previousAssistant}\nCurrent follow-up: ${question}`;
  }
  return `Previous user question: ${previousUser}\nCurrent follow-up: ${question}`;
}

export function planEvidenceConversation(
  question: string,
  history: EvidenceConversationTurn[],
  isFollowup: boolean,
  locale: "en" | "ja",
): ConversationPlan {
  const standaloneIntent = classifyStandaloneIntent(question);
  if (standaloneIntent.kind === "greeting") {
    return {
      kind: "grounded",
      question,
      effectiveQuestion: question,
      intent: standaloneIntent,
    };
  }

  if (isFollowup && isUnderspecified(question)) {
    const previousUser = previousUserQuestion(history);
    if (!previousUser) {
      return {
        kind: "clarification",
        question,
        clarificationQuestion: makeClarificationQuestion(locale),
        followups: makeClarifyingFollowups(locale),
      };
    }

    const inheritedIntent = classifyStandaloneIntent(previousUser);
    return {
      kind: "grounded",
      question,
      effectiveQuestion: rewriteWithContext(question, history),
      intent: standaloneIntent.kind !== "general"
        ? standaloneIntent
        : inheritedIntent.kind === "general"
          ? standaloneIntent
          : inheritedIntent,
    };
  }

  if (standaloneIntent.kind === "general" && isUnderspecified(question)) {
    return {
      kind: "clarification",
      question,
      clarificationQuestion: makeClarificationQuestion(locale),
      followups: makeClarifyingFollowups(locale),
    };
  }

  return {
    kind: "grounded",
    question,
    effectiveQuestion: isFollowup ? rewriteWithContext(question, history) : question,
    intent: standaloneIntent,
  };
}

export function buildClarificationResponse(
  question: string,
  evidence: EvidenceResponse,
  clarificationQuestion: string,
  followups: Followup[],
): EvidenceQueryResponse {
  return {
    question,
    status: "clarification",
    clarificationQuestion,
    segments: [],
    evidenceSummary: {
      traces: evidence.surfaces.traces.observed.length,
      metrics: evidence.surfaces.metrics.hypotheses.length,
      logs: evidence.surfaces.logs.claims.length,
    },
    followups,
  };
}

export function classifyQuestionIntent(question: string): IntentProfile {
  return classifyStandaloneIntent(question);
}
