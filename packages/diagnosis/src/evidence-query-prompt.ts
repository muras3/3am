import type { EvidenceQueryRef } from "@3amoncall/core";

export type EvidenceQueryPromptEvidence = {
  ref: EvidenceQueryRef;
  surface: "traces" | "metrics" | "logs";
  summary: string;
};

export type EvidenceQueryPromptInput = {
  question: string;
  diagnosis: {
    whatHappened: string;
    rootCauseHypothesis: string;
    immediateAction: string;
    causalChain: string[];
  } | null;
  evidence: EvidenceQueryPromptEvidence[];
};

export function buildEvidenceQueryPrompt(input: EvidenceQueryPromptInput): string {
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

Curated diagnosis:
${diagnosisSection}

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
- A fact must be something the cited evidence directly supports.
- An inference must remain narrower than the existing diagnosis; do not extend it.
- Unknown should explicitly say what cannot be concluded yet.
- For status="no_answer", segments should be empty unless one short unknown segment materially helps the operator.
`;
}
