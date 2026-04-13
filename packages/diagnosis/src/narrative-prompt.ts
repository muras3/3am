import type { DiagnosisResult, ReasoningStructure } from "3am-core";

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

  // Collect all known evidence IDs as structured objects for the constraint.
  // Presenting them in the same {kind, id} format the output uses reduces the
  // format-translation burden on the LLM and makes the constraint harder to violate.
  const allEvidenceRefs = context.proofRefs
    .flatMap((r) => r.evidenceRefs.map((e) => ({ kind: e.kind, id: e.id })));
  const knownIdsJson = allEvidenceRefs.length > 0
    ? JSON.stringify(allEvidenceRefs, null, 2)
    : "[]";

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

### Known Evidence IDs — ONLY these objects are valid for answerEvidenceRefs and evidenceBindings
${knownIdsJson}

⚠️ HARD RULE: You MUST NOT use any {kind, id} pair in answerEvidenceRefs or evidenceBindings that is not in the JSON array above.
- Do NOT invent IDs. Do NOT guess IDs. Do NOT combine IDs.
- Do NOT use metric names, field names, log message fragments, or service names as IDs.
- Copy the exact "kind" and "id" values from the array above — no modifications.
- If you cannot find a matching evidence object for a claim, omit that claim or set noAnswerReason.
- Violations will cause the evidence ref to be stripped and the claim discarded.

---

## Output Instructions

Generate ONLY the JSON object below. No prose, no markdown.

CRITICAL CONSTRAINTS:
1. headline: Keep it concise and scannable. Structure: "<title phrase>. <optional clarifying sentence>"
   - The title phrase (everything before the first period) should usually be ≤60 characters.
   - The title phrase is used as the incident title in list/map views — it must be scannable at a glance.
   - No timestamps, no UUIDs, no trace IDs in the title phrase.
   - The title phrase should end with a period.
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
   *** ONLY copy {kind, id} objects from the "Known Evidence IDs" array above. Do NOT invent new IDs. ***
   If unanswerable, set to [].
9. qa.evidenceBindings: Break the answer into claims. Each claim MUST have ≥1 concrete evidence ref.
   *** ONLY copy {kind, id} objects from the "Known Evidence IDs" array above. Do NOT invent new IDs. ***
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
    "answerEvidenceRefs": [/* ONLY objects from Known Evidence IDs array above — e.g. {"kind": "span", "id": "..."} */],
    "evidenceBindings": [
      {"claim": "...", "evidenceRefs": [/* ONLY objects from Known Evidence IDs array above */]}
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
