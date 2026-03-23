import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { QABlock, EvidenceRef, Followup } from "../../../api/curated-types.js";
import type { LensSearchParams } from "../../../routes/__root.js";

interface Props {
  qa: QABlock;
  inputValue: string;
  isSubmitting: boolean;
  submitError?: string;
  latestReply?: string;
  onInputChange: (value: string) => void;
  onSubmitQuestion: (question: string) => void;
}

function evidenceRefTarget(ref: EvidenceRef): { tab: "traces" | "metrics" | "logs"; targetId: string } {
  const tabMap: Record<string, "traces" | "metrics" | "logs"> = {
    span: "traces",
    metric: "metrics",
    metric_group: "metrics",
    log: "logs",
    log_cluster: "logs",
  };

  return {
    tab: tabMap[ref.kind] ?? "traces",
    targetId: ref.kind === "span" ? ref.id.split(":").at(-1) ?? ref.id : ref.id,
  };
}

function EvidenceRefLink({ ref: evidenceRef }: { ref: EvidenceRef }) {
  const navigate = useNavigate();
  const search = useSearch({ from: "__root__" }) as LensSearchParams;
  const { tab, targetId } = evidenceRefTarget(evidenceRef);

  function apply() {
    void navigate({
      to: "/",
      search: {
        ...search,
        tab,
        targetId,
      },
      replace: true,
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      apply();
    }
  }

  return (
    <span
      role="button"
      tabIndex={0}
      className="lens-ev-qa-ref"
      onClick={apply}
      onKeyDown={handleKeyDown}
      aria-label={`View evidence: ${evidenceRef.kind} ${evidenceRef.id}`}
    >
      {evidenceRef.kind}:{evidenceRef.id}
    </span>
  );
}

function FollowupChip({
  followup,
  disabled,
  onAsk,
}: {
  followup: Followup;
  disabled: boolean;
  onAsk: (question: string) => void;
}) {
  return (
    <button
      className="lens-ev-qa-chip"
      type="button"
      disabled={disabled}
      onClick={() => onAsk(followup.question)}
    >
      {followup.question}
    </button>
  );
}

export function QAFrame({
  qa,
  inputValue,
  isSubmitting,
  submitError,
  latestReply,
  onInputChange,
  onSubmitQuestion,
}: Props) {
  const [draft, setDraft] = useState(inputValue);

  useEffect(() => {
    setDraft(inputValue);
  }, [inputValue]);

  const { traces, metrics, logs } = qa.evidenceSummary;
  const evidenceSummaryText = [
    traces > 0 ? `${traces} traces` : null,
    metrics > 0 ? `${metrics} metrics` : null,
    logs > 0 ? `${logs} logs` : null,
  ].filter(Boolean).join(", ");

  function submit(question: string) {
    const trimmed = question.trim();
    if (!trimmed || isSubmitting) return;
    onSubmitQuestion(trimmed);
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    submit(draft);
  }

  return (
    <div className="lens-ev-qa-frame" role="region" aria-label="Question and answer">
      <form className="lens-ev-qa-question-row lens-ev-qa-form" onSubmit={handleSubmit}>
        <span className="lens-ev-qa-icon" aria-hidden="true">?</span>
        <input
          className="lens-ev-qa-input"
          type="text"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            onInputChange(e.target.value);
          }}
          placeholder="Ask a question about this incident"
          aria-label="Ask a question about this incident"
          disabled={isSubmitting}
        />
        {evidenceSummaryText && (
          <span className="lens-ev-qa-time" aria-label="Evidence summary">
            {evidenceSummaryText}
          </span>
        )}
        <button
          className="lens-ev-qa-submit"
          type="submit"
          disabled={isSubmitting || draft.trim().length === 0}
        >
          {isSubmitting ? "Asking…" : "Ask"}
        </button>
      </form>

      {submitError && (
        <div className="lens-ev-qa-error" role="alert">
          {submitError}
        </div>
      )}

      {latestReply && (
        <div className="lens-ev-qa-answer lens-ev-qa-answer-live" role="status" aria-live="polite">
          <strong>Copilot reply:</strong> {latestReply}
        </div>
      )}

      {qa.noAnswerReason ? (
        <div className="lens-ev-qa-answer lens-ev-qa-answer-placeholder">
          <div className="lens-ev-qa-state-label">Current read</div>
          <div>{qa.answer}</div>
          <div className="lens-ev-qa-no-answer">
            <span className="lens-ev-qa-state-label">Still preparing</span>
            {qa.noAnswerReason}
          </div>
        </div>
      ) : (
        <div className="lens-ev-qa-answer" role="article">
          <strong>Answer:</strong> {qa.answer}

          {qa.evidenceRefs.length > 0 && (
            <div className="lens-ev-qa-refs" aria-label="Evidence references">
              <span className="lens-ev-qa-refs-label">Evidence: </span>
              {qa.evidenceRefs.map((ref, i) => (
                <EvidenceRefLink key={`${ref.kind}-${ref.id}-${i}`} ref={ref} />
              ))}
            </div>
          )}

          {evidenceSummaryText && (
            <div className="lens-ev-qa-evidence-note" aria-label="Evidence count">
              ↓ Evidence below supports this answer ({evidenceSummaryText})
            </div>
          )}
        </div>
      )}

      {qa.followups.length > 0 && (
        <div className="lens-ev-qa-followups" role="group" aria-label="Follow-up questions">
          {qa.followups.map((followup) => (
            <FollowupChip
              key={followup.question}
              followup={followup}
              disabled={isSubmitting}
              onAsk={submit}
            />
          ))}
        </div>
      )}
    </div>
  );
}
