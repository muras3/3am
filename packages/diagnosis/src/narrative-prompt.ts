import type { DiagnosisResult, ReasoningStructure } from "@3amoncall/core";

export interface BuildNarrativePromptOptions {
  locale?: "en" | "ja";
}

/**
 * Build the stage 2 prompt for console narrative generation.
 *
 * Stage 2 is WORDING ONLY — no judgments, no classifications, no numeric values.
 * All deterministic data (status, counts, IDs) comes from DiagnosisResult and
 * ReasoningStructure; the LLM only generates human-readable text.
 */
export function buildNarrativePrompt(
  diagnosisResult: DiagnosisResult,
  context: ReasoningStructure,
  options?: BuildNarrativePromptOptions,
): string {
  const dr = diagnosisResult;
  const proofRefsSummary = context.proofRefs
    .map((r) => {
      const refs = r.evidenceRefs.length > 0
        ? r.evidenceRefs.map((e) => `${e.kind}:${e.id}`).join(", ")
        : "(no evidence refs)";
      return `  ${r.cardId} [${r.status}] → ${r.targetSurface}: ${refs}`;
    })
    .join("\n");

  const absenceSummary = context.absenceCandidates.length > 0
    ? context.absenceCandidates
        .map((a) => `  ${a.id}: patterns=[${a.patterns.join(", ")}] matchCount=${a.matchCount}`)
        .join("\n")
    : "  (none)";

  const blastSummary = context.blastRadius
    .map((b) => `  ${b.label}: ${b.status} (${b.displayValue})`)
    .join("\n");

  const availableKinds = context.qaContext.availableEvidenceKinds.join(", ");

  // Collect all known evidence IDs for the constraint
  const allEvidenceIds = context.proofRefs
    .flatMap((r) => r.evidenceRefs.map((e) => `${e.kind}:${e.id}`));
  const knownIdsStr = allEvidenceIds.length > 0
    ? allEvidenceIds.join("\n  ")
    : "(none)";

  return `You are generating console-facing narrative for an incident management UI.

Your job is WORDING ONLY. Do not make judgments, classifications, or numeric assessments.
All deterministic data (proof card status, evidence counts, blast radius) is already decided.
You translate structured evidence into operator-readable text.

## Stage 1 Diagnosis Result (already determined)

### Summary
  what_happened: ${dr.summary.what_happened}
  root_cause_hypothesis: ${dr.summary.root_cause_hypothesis}

### Recommendation
  immediate_action: ${dr.recommendation.immediate_action}
  action_rationale_short: ${dr.recommendation.action_rationale_short}
  do_not: ${dr.recommendation.do_not}

### Causal Chain
${dr.reasoning.causal_chain.map((s, i) => `  [${i + 1}] ${s.type}: ${s.title} — ${s.detail}`).join("\n")}

### Confidence (stage 1 text)
  assessment: ${dr.confidence.confidence_assessment}
  uncertainty: ${dr.confidence.uncertainty}

### Operator Checks
${dr.operator_guidance.operator_checks.map((c, i) => `  [${i + 1}] ${c}`).join("\n")}

## Receiver Context (deterministic)

### Evidence Counts
  Traces: ${context.evidenceCounts.traces} (${context.evidenceCounts.traceErrors} errors)
  Metrics: ${context.evidenceCounts.metrics}
  Logs: ${context.evidenceCounts.logs} (${context.evidenceCounts.logErrors} errors)

### Blast Radius
${blastSummary}

### Proof Card References
${proofRefsSummary}

### Absence Candidates
${absenceSummary}

### Timeline
  Started: ${context.timelineSummary.startedAt}
  Full cascade: ${context.timelineSummary.fullCascadeAt ?? "n/a"}
  Diagnosed: ${context.timelineSummary.diagnosedAt ?? "n/a"}

### Available Evidence Surfaces
  ${availableKinds}

### Known Evidence IDs (you may ONLY reference these)
  ${knownIdsStr}

---

## Output Instructions

Generate ONLY the JSON object below. No prose, no markdown.

CRITICAL CONSTRAINTS:
1. headline: Total ≤120 characters. Structure: "<title phrase>. <optional clarifying sentence>"
   - The title phrase (everything before the first period) MUST be ≤60 characters.
   - The title phrase is used as the incident title in list/map views — it must be scannable at a glance.
   - No timestamps, no UUIDs, no trace IDs in the title phrase.
   - The title phrase MUST end with a period.
   - You may add one short clarifying sentence after the period.
   - GOOD: "Stripe 429 rate-limit cascade hit checkout flow. Retries exhausted connection pool within 2 min."
   - BAD: "mock-cdn began serving HTTP 503 responses between 05:40:15Z and 05:42:30Z causing downstream failures across all product endpoints"
2. whyThisAction: Expand action_rationale_short into a full paragraph explaining the reasoning.
3. confidenceSummary.basis: Extract the evidence basis from the stage 1 confidence text.
4. confidenceSummary.risk: Describe the failure mode of the recommended action.
5. proofCards: Exactly 3 cards (trigger, design_gap, recovery).
   - label: Human-readable name (e.g., "External Trigger", "Design Gap", "Recovery Signal").
   - summary: One sentence describing the evidence. If the card's status is "pending" (see Proof Card References above), write a summary that acknowledges evidence is not yet available.
6. qa.question: A natural question derived from the headline.
7. qa.answer: A grounded answer referencing the evidence.
8. qa.answerEvidenceRefs: Flat list of ALL evidence refs that support the answer as a whole.
   Frontend uses this directly — it must not need to aggregate from evidenceBindings.
   If unanswerable, set to [].
9. qa.evidenceBindings: Break the answer into claims. Each claim MUST have ≥1 concrete evidence ref.
   - ONLY use IDs from the "Known Evidence IDs" list above. Do NOT invent IDs.
   - Each evidenceRef must use kind from: span, log, metric, log_cluster, metric_group.
   - answerEvidenceRefs should be the union of all evidenceBindings refs (plus any additional).
   - If the question cannot be answered with available evidence, set noAnswerReason to a string and leave both answerEvidenceRefs and evidenceBindings as [].
9. qa.followups: 3-5 follow-up questions. Each has targetEvidenceKinds (which surfaces the question relates to).
10. sideNotes: Include confidence, uncertainty, and affected dependencies.
11. absenceEvidence: For each absence candidate, generate label, expected, observed, explanation.

{
  "headline": "...",
  "whyThisAction": "...",
  "confidenceSummary": {
    "basis": "...",
    "risk": "..."
  },
  "proofCards": [
    {"id": "trigger", "label": "...", "summary": "..."},
    {"id": "design_gap", "label": "...", "summary": "..."},
    {"id": "recovery", "label": "...", "summary": "..."}
  ],
  "qa": {
    "question": "...",
    "answer": "...",
    "answerEvidenceRefs": [{"kind": "span|log|metric|log_cluster|metric_group", "id": "..."}],
    "evidenceBindings": [
      {"claim": "...", "evidenceRefs": [{"kind": "span|log|metric|log_cluster|metric_group", "id": "..."}]}
    ],
    "followups": [
      {"question": "...", "targetEvidenceKinds": ["traces|metrics|logs"]}
    ],
    "noAnswerReason": null
  },
  "sideNotes": [
    {"title": "...", "text": "...", "kind": "confidence|uncertainty|dependency"}
  ],
  "absenceEvidence": [
    {"id": "...", "label": "...", "expected": "...", "observed": "...", "explanation": "..."}
  ]
}
${options?.locale === "ja" ? `
## Language Instruction

Respond entirely in Japanese. Use concise language that an on-call engineer can act on immediately at 3am — every word should reduce time-to-action.
Keep all JSON keys in English. Only the string values should be in Japanese.
Technical terms (service names, trace IDs, metric names, HTTP status codes) stay in English.
Avoid formal or polite Japanese (敬語); use direct, action-oriented phrasing.
The "immediate_action" field must read like a command, not a suggestion.
` : ""}`;
}
