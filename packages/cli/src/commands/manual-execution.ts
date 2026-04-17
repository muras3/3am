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
  generateEvidenceQueryWithMeta,
  generateEvidenceCombined,
  generateConsoleNarrative,
  wrapUserMessage,
  type ProviderName,
  type EvidenceQueryAbsenceInput,
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

/**
 * The single deterministic safety-net. Per CLAUDE.md, may only be used when
 * the LLM provider is unreachable / all retries exhausted.
 */
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

function intentFromMode(mode: "answer" | "action" | "missing_evidence"): IntentProfile {
  if (mode === "action") {
    return { kind: "action", preferredSurfaces: ["traces", "logs", "metrics"] };
  }
  if (mode === "missing_evidence") {
    return { kind: "logs", preferredSurfaces: ["logs", "traces", "metrics"] };
  }
  return { kind: "general", preferredSurfaces: ["traces", "metrics", "logs"] };
}

function detectAbsenceInput(
  question: string,
  evidence: EvidenceResponse,
  answerMode: "answer" | "action" | "missing_evidence",
): EvidenceQueryAbsenceInput | undefined {
  if (answerMode !== "missing_evidence") return undefined;
  const absenceClaim = evidence.surfaces.logs.claims.find((claim) => claim.type === "absence");
  if (!absenceClaim) return undefined;
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

/** Providers that spawn subprocesses and pay a fixed startup cost per call. */
function isSubprocessProvider(provider: ProviderName | undefined): boolean {
  return provider === "codex" || provider === "claude-code";
}

async function buildManualEvidenceQueryAnswer(
  diagnosisResult: DiagnosisResult,
  evidence: EvidenceResponse,
  question: string,
  history: EvidenceConversationTurn[],
  options: {
    provider?: ProviderName;
    model?: string;
    locale: "en" | "ja";
    isSystemFollowup?: boolean;
    replyToClarification?: { originalQuestion: string; clarificationText: string };
  },
): Promise<EvidenceQueryResponse> {
  // When replying to a clarification, enrich the question with the original context
  // so the LLM can understand what the user is responding to
  let effectiveQuestionInput = question;
  if (options.replyToClarification) {
    effectiveQuestionInput = `${options.replyToClarification.originalQuestion} (${question})`;
  }

  const catalog = buildEvidenceCatalog(evidence, options.locale);
  const planningIntent: IntentProfile = { kind: "general", preferredSurfaces: ["traces", "metrics", "logs"] };
  const planningCandidates = retrieveEvidence(effectiveQuestionInput, catalog, planningIntent).slice(0, 8);

  const diagnosisInput = {
    whatHappened: diagnosisResult.summary.what_happened,
    rootCauseHypothesis: diagnosisResult.summary.root_cause_hypothesis,
    immediateAction: diagnosisResult.recommendation.immediate_action,
    causalChain: diagnosisResult.reasoning.causal_chain.map((step) => step.title),
  };
  const providerCallOptions = {
    provider: options.provider,
    model: options.model,
    locale: options.locale,
  };

  // ── Fast path: single LLM call for subprocess providers ──────────────────
  // codex and claude-code each cost 7-9s per subprocess invocation. The
  // default two-call flow (plan + generate) results in 15-18s total. By merging
  // both steps into a single prompt we cut this to 7-9s.
  if (isSubprocessProvider(options.provider)) {
    const t0 = Date.now();
    try {
      const allowedRefs = planningCandidates.map(({ ref }) => ref);
      const combined = await generateEvidenceCombined(
        {
          question: effectiveQuestionInput,
          isSystemFollowup: options.isSystemFollowup,
          history,
          diagnosis: diagnosisInput,
          evidence: planningCandidates.map(({ ref, surface, summary }) => ({ ref, surface, summary })),
        },
        allowedRefs,
        providerCallOptions,
      );

      const elapsed = Date.now() - t0;
      process.stderr.write(`[evidence-query] combined call elapsed=${elapsed}ms provider=${options.provider ?? "auto"}\n`);

      if (combined.kind === "clarification") {
        if (options.isSystemFollowup) {
          // System followups must never surface clarification — fall through to the
          // two-call LLM path below so synthesis still happens via LLM.
          return await buildManualTwoCallAnswer(
            diagnosisResult,
            evidence,
            question,
            history,
            options,
            { catalog, planningCandidates, planningIntent, effectiveQuestionInput, diagnosisInput, providerCallOptions },
          );
        }
        return {
          question,
          status: "clarification",
          clarificationQuestion: combined.clarificationQuestion,
          segments: [],
          evidenceSummary: summarizeEvidence(evidence.surfaces),
          followups: buildFollowups(planningCandidates, evidence, question, options.locale),
        };
      }

      return {
        ...combined.response,
        evidenceSummary: summarizeEvidence(evidence.surfaces),
        followups: buildFollowups(planningCandidates, evidence, question, options.locale),
      };
    } catch {
      // Combined call failed — fall through to the two-call path below.
      process.stderr.write(`[evidence-query] combined call failed after ${Date.now() - t0}ms, falling back to two-call path\n`);
    }
  }

  return await buildManualTwoCallAnswer(
    diagnosisResult,
    evidence,
    question,
    history,
    options,
    { catalog, planningCandidates, planningIntent, effectiveQuestionInput, diagnosisInput, providerCallOptions },
  );
}

type ManualTwoCallContext = {
  catalog: RetrievedEvidence[];
  planningCandidates: RetrievedEvidence[];
  planningIntent: IntentProfile;
  effectiveQuestionInput: string;
  diagnosisInput: {
    whatHappened: string;
    rootCauseHypothesis: string;
    immediateAction: string;
    causalChain: string[];
  };
  providerCallOptions: { provider?: ProviderName; model?: string; locale: "en" | "ja" };
};

async function buildManualTwoCallAnswer(
  diagnosisResult: DiagnosisResult,
  evidence: EvidenceResponse,
  question: string,
  history: EvidenceConversationTurn[],
  options: {
    provider?: ProviderName;
    model?: string;
    locale: "en" | "ja";
    isSystemFollowup?: boolean;
    replyToClarification?: { originalQuestion: string; clarificationText: string };
  },
  ctx: ManualTwoCallContext,
): Promise<EvidenceQueryResponse> {
  void diagnosisResult; // synthesized diagnosis fields are already in ctx.diagnosisInput
  let effectiveQuestion = ctx.effectiveQuestionInput;
  let intent: IntentProfile = ctx.planningIntent;
  let answerMode: "answer" | "action" | "missing_evidence" = "answer";

  const t0TwoCall = Date.now();
  try {
    const plan = await generateEvidencePlan(
      {
        question: ctx.effectiveQuestionInput,
        isSystemFollowup: options.isSystemFollowup,
        history,
        diagnosis: ctx.diagnosisInput,
        evidence: ctx.planningCandidates.map(({ ref, surface, summary }) => ({ ref, surface, summary })),
      },
      ctx.providerCallOptions,
    );

    if (plan.mode === "clarification" && !options.isSystemFollowup) {
      return {
        question,
        status: "clarification",
        clarificationQuestion: plan.clarificationQuestion,
        segments: [],
        evidenceSummary: summarizeEvidence(evidence.surfaces),
        followups: buildFollowups(ctx.planningCandidates, evidence, question, options.locale),
      };
    }

    effectiveQuestion = plan.rewrittenQuestion;
    answerMode = plan.mode === "clarification" ? "answer" : plan.mode;
    intent = intentFromMode(answerMode);
    intent.preferredSurfaces = plan.preferredSurfaces;
  } catch {
    // Planner failure is non-fatal — let the synthesis LLM handle the question directly.
  }

  const retrieved = retrieveEvidence(effectiveQuestion, ctx.catalog, intent);
  const evidenceStatus = classifyEvidenceStatus(retrieved);
  const absenceInput = detectAbsenceInput(effectiveQuestion, evidence, answerMode);

  try {
    const { response: generated, meta } = await generateEvidenceQueryWithMeta(
      {
        question: ctx.effectiveQuestionInput,
        answerMode,
        history,
        intent: intent.kind,
        preferredSurfaces: intent.preferredSurfaces,
        diagnosis: ctx.diagnosisInput,
        evidence: retrieved.map(({ ref, surface, summary }) => ({ ref, surface, summary })),
        diagnosisStatus: "ready",
        evidenceStatus,
        absenceInput,
        locale: options.locale,
      },
      ctx.providerCallOptions,
    );

    const elapsed = Date.now() - t0TwoCall;
    process.stderr.write(
      `[evidence-query] two-call elapsed=${elapsed}ms provider=${options.provider ?? "auto"} retries=${meta.retryCount} repaired=${meta.repairedRefCount}\n`,
    );

    return {
      ...generated,
      evidenceSummary: summarizeEvidence(evidence.surfaces),
      followups: buildFollowups(retrieved, evidence, question, options.locale),
    };
  } catch (err) {
    process.stderr.write(
      `[evidence-query] LLM synthesis failed after retries (${err instanceof Error ? err.message : String(err)}); returning safety-net no-answer.\n`,
    );
    return buildDeterministicNoAnswer(
      question,
      evidence,
      "LLM synthesis failed after retries. The evidence surfaces are available, but a grounded answer could not be generated this time.",
    );
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
  isSystemFollowup?: boolean;
  replyToClarification?: { originalQuestion: string; clarificationText: string };
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
      isSystemFollowup: options.isSystemFollowup,
      replyToClarification: options.replyToClarification,
    },
  );
}
