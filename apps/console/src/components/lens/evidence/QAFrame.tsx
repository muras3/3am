import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type {
  QABlock,
  EvidenceRef,
  EvidenceQueryRef,
  EvidenceQueryResponse,
  EvidenceQuerySegment,
  Followup,
} from "../../../api/curated-types.js";
import type { LensSearchParams } from "../../../routes/__root.js";

interface Props {
  qa: QABlock;
  inputValue: string;
  isSubmitting: boolean;
  submitError?: string;
  latestResponse?: EvidenceQueryResponse;
  onInputChange: (value: string) => void;
  onSubmitQuestion: (question: string, isFollowup?: boolean) => void;
}

function evidenceRefTarget(
  ref: EvidenceRef | EvidenceQueryRef,
): { tab: "traces" | "metrics" | "logs"; targetId: string } {
  const tabMap: Record<string, "traces" | "metrics" | "logs"> = {
    span: "traces",
    metric: "metrics",
    metric_group: "metrics",
    log: "logs",
    log_cluster: "logs",
    absence: "logs",
  };

  return {
    tab: tabMap[ref.kind] ?? "traces",
    targetId: ref.kind === "span" ? ref.id.split(":").at(-1) ?? ref.id : ref.id,
  };
}

function EvidenceRefLink({ ref: evidenceRef }: { ref: EvidenceRef | EvidenceQueryRef }) {
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

function SegmentBadge({ kind }: { kind: EvidenceQuerySegment["kind"] }) {
  const label = kind === "fact" ? "Fact" : kind === "inference" ? "Inference" : "Unknown";
  return <span className={`lens-ev-qa-segment-badge lens-ev-qa-segment-badge-${kind}`}>{label}</span>;
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
  latestResponse,
  onInputChange,
  onSubmitQuestion,
}: Props) {
  const [draft, setDraft] = useState(inputValue);
  const latestSegments = latestResponse?.segments ?? [];
  const initialSegments = qa.segments ?? [];
  const activeFollowups = latestResponse?.followups ?? qa.followups;
  const summary = latestResponse?.evidenceSummary ?? qa.evidenceSummary;

  useEffect(() => {
    setDraft(inputValue);
  }, [inputValue]);
  const evidenceSummaryText = [
    summary.traces > 0 ? `${summary.traces} traces` : null,
    summary.metrics > 0 ? `${summary.metrics} metrics` : null,
    summary.logs > 0 ? `${summary.logs} logs` : null,
  ].filter(Boolean).join(", ");

  function submit(question: string, isFollowup = false) {
    const trimmed = question.trim();
    if (!trimmed || isSubmitting) return;
    onSubmitQuestion(trimmed, isFollowup);
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
          placeholder="Ask what the evidence can actually support"
          aria-label="Ask a grounded question about this incident"
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
          {isSubmitting ? "Checking…" : "Ask"}
        </button>
      </form>

      {submitError && (
        <div className="lens-ev-qa-error" role="alert">
          {submitError}
        </div>
      )}

      {latestResponse ? (
        <div className="lens-ev-qa-answer lens-ev-qa-answer-live" role="status" aria-live="polite">
          <div className="lens-ev-qa-answer-head">
            <span className="lens-ev-qa-state-label">
              {latestResponse.status === "no_answer" ? "No answer" : "Grounded answer"}
            </span>
            {latestResponse.noAnswerReason && (
              <span className="lens-ev-qa-answer-note">{latestResponse.noAnswerReason}</span>
            )}
          </div>

          {latestSegments.length > 0 ? (
            <div className="lens-ev-qa-segments" role="article" aria-label="Answer segments">
              {latestSegments.map((segment) => (
                <div key={segment.id} className={`lens-ev-qa-segment lens-ev-qa-segment-${segment.kind}`}>
                  <div className="lens-ev-qa-segment-line">
                    <SegmentBadge kind={segment.kind} />
                    <span className="lens-ev-qa-segment-text">{segment.text}</span>
                  </div>
                  <div className="lens-ev-qa-refs" aria-label="Evidence references">
                    {segment.evidenceRefs.map((ref, i) => (
                      <EvidenceRefLink key={`${ref.kind}-${ref.id}-${i}`} ref={ref} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="lens-ev-qa-no-answer">{latestResponse.noAnswerReason}</div>
          )}
        </div>
      ) : initialSegments.length > 0 ? (
        <div
          className={`lens-ev-qa-answer${qa.status === "no_answer" ? " lens-ev-qa-answer-placeholder" : ""}`}
          role="article"
        >
          <div className="lens-ev-qa-answer-head">
            <span className="lens-ev-qa-state-label">
              {qa.status === "no_answer" ? "No answer" : "Prepared read"}
            </span>
            {qa.noAnswerReason && (
              <span className="lens-ev-qa-answer-note">{qa.noAnswerReason}</span>
            )}
          </div>
          <div className="lens-ev-qa-segments" aria-label="Prepared answer segments">
            {initialSegments.map((segment) => (
              <div key={segment.id} className={`lens-ev-qa-segment lens-ev-qa-segment-${segment.kind}`}>
                <div className="lens-ev-qa-segment-line">
                  <SegmentBadge kind={segment.kind} />
                  <span className="lens-ev-qa-segment-text">{segment.text}</span>
                </div>
                <div className="lens-ev-qa-refs" aria-label="Evidence references">
                  {segment.evidenceRefs.map((ref, i) => (
                    <EvidenceRefLink key={`${ref.kind}-${ref.id}-${i}`} ref={ref} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : qa.noAnswerReason ? (
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
          <div className="lens-ev-qa-answer-head">
            <span className="lens-ev-qa-state-label">Prepared read</span>
          </div>
          <div>{qa.answer}</div>

          {qa.evidenceRefs.length > 0 && (
            <div className="lens-ev-qa-refs" aria-label="Evidence references">
              {qa.evidenceRefs.map((ref, i) => (
                <EvidenceRefLink key={`${ref.kind}-${ref.id}-${i}`} ref={ref} />
              ))}
            </div>
          )}
        </div>
      )}

      {activeFollowups.length > 0 && (
        <div className="lens-ev-qa-followups" role="group" aria-label="Follow-up questions">
          {activeFollowups.map((followup) => (
            <FollowupChip
              key={followup.question}
              followup={followup}
              disabled={isSubmitting}
              onAsk={(question) => submit(question, true)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
