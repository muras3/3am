/**
 * evidence-query.ts — Domain logic for POST /api/incidents/:id/evidence/query.
 *
 * Generates evidence-grounded Q&A answers. When diagnosis is available,
 * uses LLM with evidence context. When unavailable, returns a deterministic
 * no-answer response.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Incident } from "../storage/interface.js";
import type { TelemetryStoreDriver } from "../telemetry/interface.js";
import type { EvidenceQueryResponse, EvidenceSummary } from "@3amoncall/core";

const EVIDENCE_QUERY_MODEL =
  process.env["EVIDENCE_QUERY_MODEL"] ?? "claude-haiku-4-5-20251001";

type DiagnosisState = "ready" | "pending" | "unavailable";

function determineDiagnosisState(incident: Incident): DiagnosisState {
  if (incident.diagnosisResult) return "ready";
  if (incident.diagnosisDispatchedAt) return "pending";
  return "unavailable";
}

function buildEvidenceSummary(incident: Incident): EvidenceSummary {
  const evidence = incident.packet.evidence;
  return {
    traces: evidence.representativeTraces.length,
    metrics: evidence.changedMetrics.length,
    logs: evidence.relevantLogs.length,
  };
}

function buildDefaultFollowups(incident: Incident): EvidenceQueryResponse["followups"] {
  const evidence = incident.packet.evidence;
  const followups: EvidenceQueryResponse["followups"] = [];

  if (evidence.representativeTraces.length > 0) {
    followups.push({ question: "Open traces", targetEvidenceKinds: ["traces"] });
  }
  if (evidence.changedMetrics.length > 0) {
    followups.push({ question: "Inspect metrics drift", targetEvidenceKinds: ["metrics"] });
  }
  if (evidence.relevantLogs.length > 0) {
    followups.push({ question: "Review related logs", targetEvidenceKinds: ["logs"] });
  }

  // If nothing is available yet, return generic fallbacks
  if (followups.length === 0) {
    return [
      { question: "What traces are available?", targetEvidenceKinds: ["traces"] },
      { question: "Show metrics drift", targetEvidenceKinds: ["metrics"] },
      { question: "Review logs", targetEvidenceKinds: ["logs"] },
    ];
  }

  return followups;
}

function buildLLMSystemPrompt(incident: Incident): string {
  const dr = incident.diagnosisResult!;
  const narrative = incident.consoleNarrative!;

  const chain = dr.reasoning.causal_chain.map((s) => `${s.type}: ${s.title}`).join(" → ");

  const proofCardLines = narrative.proofCards
    .map((c) => `  - ${c.id}: ${c.label} — ${c.summary}`)
    .join("\n");

  const qaContext =
    `Initial question: ${narrative.qa.question}\n` +
    `Initial answer: ${narrative.qa.answer}`;

  const evidenceRefLines = narrative.qa.answerEvidenceRefs
    .map((r) => `  - kind=${r.kind} id=${r.id}`)
    .join("\n");

  return (
    "You are an incident responder assistant. Answer the user's question strictly based on the provided incident evidence context.\n\n" +
    `## Diagnosis Summary\n` +
    `What happened: ${dr.summary.what_happened}\n` +
    `Root cause: ${dr.summary.root_cause_hypothesis}\n` +
    `Immediate action: ${dr.recommendation.immediate_action}\n` +
    `Causal chain: ${chain}\n\n` +
    `## Narrative Context\n${qaContext}\n\n` +
    `## Proof Cards\n${proofCardLines}\n\n` +
    `## Available Evidence Refs\n${evidenceRefLines}\n\n` +
    "Respond ONLY with valid JSON in this exact shape:\n" +
    '{ "answer": "<string>", "evidenceRefs": [{"kind": "<kind>", "id": "<id>"}], "followups": ["<string>"] }\n\n' +
    "Rules:\n" +
    "- answer: 2-4 sentences, factual, grounded in the diagnosis and evidence above\n" +
    "- evidenceRefs: only ref IDs from the available evidence refs above\n" +
    "- followups: 2-3 short follow-up questions the engineer might ask next\n" +
    "- Do not speculate beyond the provided context"
  );
}

interface LLMQueryResult {
  answer: string;
  evidenceRefs: Array<{ kind: string; id: string }>;
  followups: string[];
}

function parseLLMResponse(text: string): LLMQueryResult | null {
  try {
    // Strip any markdown code fences if present
    const jsonText = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;

    if (
      typeof parsed["answer"] !== "string" ||
      !Array.isArray(parsed["evidenceRefs"]) ||
      !Array.isArray(parsed["followups"])
    ) {
      return null;
    }

    const rawRefs = (parsed["evidenceRefs"] as unknown[]).filter(
      (r): r is { kind: string; id: string } =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as Record<string, unknown>)["kind"] === "string" &&
        typeof (r as Record<string, unknown>)["id"] === "string",
    );

    return {
      answer: parsed["answer"] as string,
      evidenceRefs: rawRefs,
      followups: (parsed["followups"] as unknown[]).filter(
        (f): f is string => typeof f === "string",
      ),
    };
  } catch {
    return null;
  }
}

function buildConfidenceFromRefs(
  refCount: number,
): EvidenceQueryResponse["confidence"] {
  if (refCount >= 3) return { label: "high", value: 0.85 };
  if (refCount >= 1) return { label: "medium", value: 0.6 };
  return { label: "low", value: 0.3 };
}

function toEvidenceRef(
  raw: { kind: string; id: string },
): EvidenceQueryResponse["evidenceRefs"][number] | null {
  const validKinds = ["span", "log", "metric", "log_cluster", "metric_group"] as const;
  if (!validKinds.includes(raw.kind as (typeof validKinds)[number])) return null;
  return { kind: raw.kind as (typeof validKinds)[number], id: raw.id };
}

export async function buildEvidenceQueryAnswer(
  incident: Incident,
  _telemetryStore: TelemetryStoreDriver,
  question: string,
  _isFollowup: boolean,
): Promise<EvidenceQueryResponse> {
  const diagnosisState = determineDiagnosisState(incident);

  // ── Path 1: No diagnosis at all ──────────────────────────────────────────
  if (diagnosisState === "unavailable" || diagnosisState === "pending") {
    return {
      question,
      answer:
        "Diagnosis is not yet available. Evidence surfaces below show the raw telemetry data collected so far.",
      confidence: { label: "unavailable", value: 0 },
      evidenceRefs: [],
      evidenceSummary: buildEvidenceSummary(incident),
      followups: buildDefaultFollowups(incident),
      noAnswerReason:
        diagnosisState === "pending"
          ? "Diagnosis is still running. Answers will be available when diagnosis completes."
          : "No diagnosis has been triggered for this incident yet.",
    };
  }

  const dr = incident.diagnosisResult!;

  // ── Path 2: Diagnosis ready, but no consoleNarrative ────────────────────
  if (!incident.consoleNarrative) {
    const whatHappened = dr.summary.what_happened;
    const immediateAction = dr.recommendation.immediate_action;

    return {
      question,
      answer: `Based on the diagnosis: ${whatHappened}. Recommended action: ${immediateAction}. See evidence surfaces below for supporting data.`,
      confidence: { label: "medium", value: 0.5 },
      evidenceRefs: [],
      evidenceSummary: buildEvidenceSummary(incident),
      followups: buildDefaultFollowups(incident),
    };
  }

  // ── Path 3: Full LLM answer ──────────────────────────────────────────────
  const systemPrompt = buildLLMSystemPrompt(incident);
  const userMessage = `<user_question>${question}</user_question>`;

  const client = new Anthropic({
    baseURL: process.env["ANTHROPIC_BASE_URL"],
    apiKey: process.env["ANTHROPIC_API_KEY"] ?? "no-key",
  });

  let llmResult: LLMQueryResult | null = null;

  try {
    const response = await client.messages.create({
      model: EVIDENCE_QUERY_MODEL,
      max_tokens: 1024,
      temperature: 0.2,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    llmResult = parseLLMResponse(text);
  } catch {
    // LLM failure: fall back to path 2 behavior
  }

  if (!llmResult) {
    const whatHappened = dr.summary.what_happened;
    const immediateAction = dr.recommendation.immediate_action;

    return {
      question,
      answer: `Based on the diagnosis: ${whatHappened}. Recommended action: ${immediateAction}. See evidence surfaces below for supporting data.`,
      confidence: { label: "medium", value: 0.5 },
      evidenceRefs: [],
      evidenceSummary: buildEvidenceSummary(incident),
      followups: buildDefaultFollowups(incident),
    };
  }

  const validRefs = llmResult.evidenceRefs
    .map(toEvidenceRef)
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const followupObjects: EvidenceQueryResponse["followups"] = llmResult.followups.map((q) => ({
    question: q,
    targetEvidenceKinds: ["traces"] as ["traces"],
  }));

  const evidenceSummary: EvidenceSummary = {
    traces: validRefs.filter((r) => r.kind === "span").length,
    metrics: validRefs.filter((r) => r.kind === "metric" || r.kind === "metric_group").length,
    logs: validRefs.filter((r) => r.kind === "log" || r.kind === "log_cluster").length,
  };

  return {
    question,
    answer: llmResult.answer,
    confidence: buildConfidenceFromRefs(validRefs.length),
    evidenceRefs: validRefs,
    evidenceSummary,
    followups: followupObjects.length > 0 ? followupObjects : buildDefaultFollowups(incident),
  };
}
