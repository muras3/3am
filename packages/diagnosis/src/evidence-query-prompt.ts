import type { EvidenceQueryRef } from "@3amoncall/core";

export type EvidenceQueryPromptEvidence = {
  ref: EvidenceQueryRef;
  surface: "traces" | "metrics" | "logs";
  summary: string;
};

export type EvidenceQueryPromptInput = {
  question: string;
  history?: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  intent: string;
  preferredSurfaces: Array<"traces" | "metrics" | "logs">;
  diagnosis: {
    whatHappened: string;
    rootCauseHypothesis: string;
    immediateAction: string;
    causalChain: string[];
  } | null;
  evidence: EvidenceQueryPromptEvidence[];
};

export function buildEvidenceQueryPrompt(
  input: EvidenceQueryPromptInput,
  options?: { locale?: "en" | "ja" },
): string {
  const diagnosisSection = input.diagnosis
    ? [
        `what_happened: ${input.diagnosis.whatHappened}`,
        `root_cause_hypothesis: ${input.diagnosis.rootCauseHypothesis}`,
        `immediate_action: ${input.diagnosis.immediateAction}`,
        `causal_chain: ${input.diagnosis.causalChain.join(" -> ") || "(none)"}`,
      ].join("\n")
    : "Diagnosis is unavailable. Do not infer beyond the curated evidence list.";

  const evidenceSection = input.evidence.length > 0
    ? input.evidence
        .map(
          ({ ref, surface, summary }, index) =>
            `  [${index + 1}] ${ref.kind}:${ref.id} surface=${surface} summary=${summary}`,
        )
        .join("\n")
    : "  (none)";

  const prioritySection = [
    `question_intent: ${input.intent}`,
    `preferred_surfaces: ${input.preferredSurfaces.join(", ") || "(none)"}`,
  ].join("\n");
  const historySection = input.history && input.history.length > 0
    ? input.history
        .slice(-8)
        .map((turn, index) => `  [${index + 1}] ${turn.role}: ${turn.content}`)
        .join("\n")
    : "  (none)";

  const localeInstruction = options?.locale === "ja"
    ? `
Respond entirely in Japanese. Keep all JSON keys in English.
Use direct, concise Japanese. Do not use polite or formal phrasing.
`
    : "";

  return `You are generating a grounded Q&A answer for an incident evidence console.

This is NOT generic chat. This is a single-turn grounded answer generator.

Product contract:
- Do not create a new root cause.
- You may use the existing diagnosis only as background for limited inference.
- fact = directly supported by curated evidence.
- inference = supported by curated evidence plus the existing diagnosis, and only within a natural, conservative reading.
- unknown = the current evidence is insufficient to state the claim responsibly.
- If the question cannot be answered responsibly, return status="no_answer" with a clear noAnswerReason.
- Every segment must cite at least one evidence ref from the curated list below.
- Never output a claim without evidenceRefs.
- Never invent evidence IDs.
- Never turn this into generic advice, small talk, or a troubleshooting playbook.
- Use recent conversation history to resolve underspecified follow-up questions whenever the referent is reasonably clear.
- If the user asks for the next action or how something should behave, answer with the minimum concrete action that follows from the diagnosis and cited evidence.

Curated diagnosis:
${diagnosisSection}

Question routing:
${prioritySection}

Recent conversation history:
${historySection}

Curated evidence refs you may cite:
${evidenceSection}

User question:
${input.question}

Respond with ONLY valid JSON in this shape:
{
  "status": "answered" | "no_answer",
  "segments": [
    {
      "kind": "fact" | "inference" | "unknown",
      "text": "one sentence",
      "evidenceRefs": [
        { "kind": "span" | "metric_group" | "log_cluster" | "absence", "id": "..." }
      ]
    }
  ],
  "noAnswerReason": "string or omitted"
}

Hard rules:
- Keep segments sentence-level and concise.
- Prefer 2-4 segments when status="answered".
- If more than half of the answer would be unknown, use status="no_answer" instead.
- Match the answer structure to the user question.
- If the question is about metrics, answer primarily from metric evidence before using any diagnosis inference.
- If the question is about logs, answer primarily from log evidence before using any diagnosis inference.
- If the question is about traces or a failing path, answer primarily from trace evidence.
- If the question asks for the cause or root cause, summarize the existing diagnosis but anchor it in retrieved evidence.
- If the question is a short follow-up like "what next?" or "how should it behave?", use recent conversation history to infer the target and answer directly.
- Do not repeat the same inference sentence across different question types unless the evidence genuinely leaves no better answer.
- Make every fact segment readable as a standalone sentence; never emit fragments such as a single noun phrase.
- A fact must be something the cited evidence directly supports.
- An inference must remain narrower than the existing diagnosis; do not extend it.
- Unknown should explicitly say what cannot be concluded yet.
- For status="no_answer", segments should be empty unless one short unknown segment materially helps the operator.
- For greetings or off-topic questions, return status="no_answer" with one short noAnswerReason and no duplicated wording.
${localeInstruction}
`;
}
