import type { EvidenceQueryRef } from "3am-core";

export type EvidencePlanPromptEvidence = {
  ref: EvidenceQueryRef;
  surface: "traces" | "metrics" | "logs";
  summary: string;
};

export type EvidencePlanPromptInput = {
  question: string;
  history?: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  diagnosis: {
    whatHappened: string;
    rootCauseHypothesis: string;
    immediateAction: string;
    causalChain: string[];
  } | null;
  evidence: EvidencePlanPromptEvidence[];
};

export function buildEvidencePlanPrompt(
  input: EvidencePlanPromptInput,
  options?: { locale?: "en" | "ja" },
): string {
  const diagnosisSection = input.diagnosis
    ? [
        `what_happened: ${input.diagnosis.whatHappened}`,
        `root_cause_hypothesis: ${input.diagnosis.rootCauseHypothesis}`,
        `immediate_action: ${input.diagnosis.immediateAction}`,
        `causal_chain: ${input.diagnosis.causalChain.join(" -> ") || "(none)"}`,
      ].join("\n")
    : "Diagnosis is unavailable.";

  const historySection = input.history && input.history.length > 0
    ? input.history.slice(-8).map((turn, index) => `  [${index + 1}] ${turn.role}: ${turn.content}`).join("\n")
    : "  (none)";

  const evidenceSection = input.evidence.length > 0
    ? input.evidence
        .map(({ ref, surface, summary }, index) => `  [${index + 1}] ${ref.kind}:${ref.id} surface=${surface} summary=${summary}`)
        .join("\n")
    : "  (none)";

  const localeInstruction = options?.locale === "ja"
    ? `
Respond entirely in Japanese. Keep all JSON keys in English.
Use direct, concise Japanese. Do not use polite or formal phrasing.
`
    : "";

  return `You are the planning layer for an incident evidence copilot.

Decide how the system should answer the user's question before grounded generation.

You must choose exactly one mode:
- "answer": the user is asking for explanation or diagnosis and the current evidence is enough to answer now.
- "action": the user is asking what to do next, how to respond, or what should happen operationally.
- "missing_evidence": the user is asking why logs/metrics/traces are missing or what absence means.
- "clarification": the user's question is still too ambiguous even after using the recent conversation history.

Do not be lazy with clarification.
- If recent history makes the target obvious, do NOT clarify.
- If the question is "what should I do", "what next", "so what", and the previous turn established the topic, choose "action".
- If the question asks why logs or other evidence are missing, choose "missing_evidence".
- If the user is asking about the incident generally, choose "answer".
- When the user asks about "first", "earliest", "latest", or similar temporal qualifiers, default to the current incident window as the scope unless the question is explicitly ambiguous about a different scope.
- Questions that resemble system-suggested follow-ups (e.g., asking about a trace path, log cluster, or metric after the system suggested it) should generally be answered, not clarified. Treat them as scoped to the incident window.

Recent conversation history:
${historySection}

Diagnosis summary:
${diagnosisSection}

Candidate evidence summaries:
${evidenceSection}

User question:
${input.question}

Return ONLY valid JSON in this shape:
{
  "mode": "answer" | "action" | "missing_evidence" | "clarification",
  "rewrittenQuestion": "self-contained version of the user's intent",
  "preferredSurfaces": ["traces" | "metrics" | "logs"],
  "clarificationQuestion": "required only when mode=clarification"
}

Rules:
- rewrittenQuestion must be self-contained and reflect the user's actual intent, not just copy the input.
- Use history aggressively to resolve pronouns and short follow-ups.
- preferredSurfaces should prioritize the evidence needed for the chosen mode.
- For "action", rewrite toward the concrete operator task.
- For "missing_evidence", rewrite toward explaining the absence and the next verification step.
- For "clarification", ask for the minimum clarification that will unblock a useful answer.
- Never output any text outside JSON.
${localeInstruction}
`;
}
