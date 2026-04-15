import type { EvidenceQueryRef } from "3am-core";

export type EvidenceQueryPromptEvidence = {
  ref: EvidenceQueryRef;
  surface: "traces" | "metrics" | "logs";
  summary: string;
};

/**
 * Structured absence claim passed to the LLM when the user asks why a signal
 * is missing. The synthesis layer must distinguish:
 *   - "no-record-found"     : the signal was never emitted in the window
 *   - "no-supporting-evidence": collected but contradicts the hypothesis
 *   - "not-yet-available"    : telemetry source still catching up
 *
 * Per AbstentionBench (NeurIPS 2025): LLMs tend to conflate "absent" with
 * "nonexistent". Feeding an explicit claimType keeps the answer honest.
 */
export type EvidenceQueryAbsenceInput = {
  claimId: string;
  label: string;
  claimType: "no-record-found" | "no-supporting-evidence" | "not-yet-available";
};

export type EvidenceQueryPromptInput = {
  question: string;
  answerMode?: "answer" | "action" | "missing_evidence";
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
  /**
   * Detection-layer signal passed from code. The LLM does not decide this;
   * it adapts its synthesis based on the value.
   */
  diagnosisStatus?: "ready" | "pending" | "unavailable";
  /**
   * Detection-layer signal about how much retrieved evidence is available.
   * Drives "say what's missing" vs. "answer from evidence" behavior.
   */
  evidenceStatus?: "empty" | "sparse" | "dense";
  /**
   * Locale hint for greeting/off-topic synthesis.
   */
  locale?: "en" | "ja";
  /**
   * Structured absence claim when the user asks about a missing signal.
   */
  absenceInput?: EvidenceQueryAbsenceInput;
  /**
   * Hint to the LLM during retry attempts. Callers append a stricter reminder
   * that only refs from the allowed list may be cited.
   */
  strictRefReminder?: boolean;
};

export function buildEvidenceQueryPrompt(
  input: EvidenceQueryPromptInput,
  options?: { locale?: "en" | "ja" },
): string {
  const diagnosisStatus = input.diagnosisStatus ?? (input.diagnosis ? "ready" : "unavailable");
  const evidenceStatus = input.evidenceStatus ?? (input.evidence.length === 0 ? "empty" : input.evidence.length <= 2 ? "sparse" : "dense");

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

  const validRefsSection = input.evidence.length > 0
    ? input.evidence.map(({ ref }) => `${ref.kind}:${ref.id}`).join(", ")
    : "(none)";

  const prioritySection = [
    `answer_mode: ${input.answerMode ?? "answer"}`,
    `question_intent: ${input.intent}`,
    `preferred_surfaces: ${input.preferredSurfaces.join(", ") || "(none)"}`,
    `diagnosis_status: ${diagnosisStatus}`,
    `evidence_status: ${evidenceStatus}`,
  ].join("\n");
  const historySection = input.history && input.history.length > 0
    ? input.history
        .slice(-8)
        .map((turn, index) => `  [${index + 1}] ${turn.role}: ${turn.content}`)
        .join("\n")
    : "  (none)";

  const absenceSection = input.absenceInput
    ? [
        `claim_id: ${input.absenceInput.claimId}`,
        `label: ${input.absenceInput.label}`,
        `claim_type: ${input.absenceInput.claimType}`,
      ].join("\n")
    : "(none)";

  const effectiveLocale = options?.locale ?? input.locale ?? "en";
  const localeInstruction = effectiveLocale === "ja"
    ? `
Respond entirely in Japanese. Keep all JSON keys in English.
Use direct, concise Japanese. Do not use polite or formal phrasing.
`
    : "";

  const strictRefBlock = input.strictRefReminder
    ? `
STRICT RETRY REMINDER:
The previous generation cited evidence ref IDs that are not in the allowed list.
You MUST cite ONLY the ref IDs listed in <valid_refs> below. Do not invent, guess,
or abbreviate IDs. If none of the listed refs materially support a segment, omit
the segment instead of citing an unrelated one.
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
- Every segment must cite at least one evidence ref from the curated list below.
- Never output a claim without evidenceRefs.
- Never invent evidence IDs. The allowed IDs are listed in <valid_refs>.
- Never turn this into generic advice, small talk, or a troubleshooting playbook.
- Use recent conversation history to resolve underspecified follow-up questions whenever the referent is reasonably clear.
- If the user asks for the next action or how something should behave, answer with the minimum concrete action that follows from the diagnosis and cited evidence.
- Do not repeat the previous assistant answer unless the user is explicitly asking for the same thing again.
- Follow the answer_mode strictly. If answer_mode is "action", return operational next steps. If "missing_evidence", explain the missing signal and the next verification step.

Diagnosis-state handling (diagnosis_status field above):
- If diagnosis_status is "ready": you may cite the existing diagnosis as background for inference segments.
- If diagnosis_status is "pending": diagnosis is still running. Summarize what the CURRENT evidence already shows (traces/metrics/logs observed so far), and explicitly state that diagnosis is still running. Do NOT speculate on root cause beyond what evidence directly supports. Prefer short, honest segments.
- If diagnosis_status is "unavailable": diagnosis has not been run. Answer only what the curated evidence directly shows, and explicitly invite the operator to run diagnosis (e.g. "run 3am diagnose to get a hypothesis"). Do NOT invent a root cause.

Evidence-availability handling (evidence_status field above):
- If evidence_status is "empty": there is no curated evidence for this question. Do NOT fabricate evidence. Explain precisely what is missing (e.g. "no logs in current 15-minute window", "no metric group matching checkout"), and propose concrete next steps (widen the time window, install a logger such as pino, run diagnosis, or check the instrumentation). Return status="no_answer" with a clear noAnswerReason in this case.
- If evidence_status is "sparse" or "dense": synthesize from the retrieved evidence directly.

Greeting / off-topic handling:
- If the user's message is a greeting (hi, hello, hey, yo, こんにちは, こんばんは, おはよう, 挨拶) or off-topic small-talk, return a single brief incident-aware reply:
  - For English: one line that mentions the incident is active and asks "What would you like to check — traces, metrics, logs, or the diagnosed cause?"
  - For Japanese: "このインシデントは調査中です。トレース・メトリクス・ログ・診断結果のどれを確認する？"
  - Use status="no_answer" with a noAnswerReason summarizing this one-line reply. No evidence refs are required when status="no_answer".

Explanatory / glossary questions:
- If the user asks "what is X?" / "define X" / "X とは?" / "X って何?", explain the term WITHIN THIS INCIDENT's context. Cite the most relevant evidence ref(s) from the curated list that illustrate the term as it manifests here. Do NOT produce a generic dictionary definition.

Absence-claim handling (absence_input field above):
- If absence_input is provided, explain what is missing according to its claim_type:
  - "no-record-found": the signal was NOT collected in the window; say so and suggest widening the window or checking the collector.
  - "no-supporting-evidence": the signal was collected but contradicts the hypothesis; say so and suggest a different angle.
  - "not-yet-available": the telemetry source is still catching up; say so and suggest re-running in a few minutes.
- Never conflate absence with nonexistence.

Curated diagnosis:
${diagnosisSection}

Question routing:
${prioritySection}

Recent conversation history:
${historySection}

Absence input (if any):
${absenceSection}

Curated evidence refs you may cite:
${evidenceSection}

<valid_refs>${validRefsSection}</valid_refs>

User question:
${input.question}
${strictRefBlock}
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
- If the user asks why evidence is missing, explain the missing-evidence state and the next verification step instead of restating the root cause.
- Do not repeat the same inference sentence across different question types unless the evidence genuinely leaves no better answer.
- Make every fact segment readable as a standalone sentence; never emit fragments such as a single noun phrase.
- A fact must be something the cited evidence directly supports.
- An inference must remain narrower than the existing diagnosis; do not extend it.
- Unknown should explicitly say what cannot be concluded yet.
- For status="no_answer", segments should be empty unless one short unknown segment materially helps the operator.
${localeInstruction}
`;
}
