import { ArrowUp } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type {
  QABlock,
  EvidenceRef,
  EvidenceQueryRef,
  EvidenceQueryResponse,
  EvidenceQuerySegment,
} from "../../../api/curated-types.js";
import { useLensSearch } from "../../../routes/__root.js";

export interface QAHistoryItem {
  id: string;
  question: string;
  status: "pending" | "answered" | "failed";
  response?: EvidenceQueryResponse;
  error?: string;
}

interface Props {
  qa: QABlock;
  inputValue: string;
  history: QAHistoryItem[];
  isSubmitting: boolean;
  onInputChange: (value: string) => void;
  onSubmitQuestion: (question: string) => void;
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
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useLensSearch();
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
      aria-label={t("evidence.qa.viewEvidence", { kind: evidenceRef.kind, id: evidenceRef.id })}
    >
      {evidenceRef.kind}:{evidenceRef.id}
    </span>
  );
}

function SegmentBadge({ kind }: { kind: EvidenceQuerySegment["kind"] }) {
  const { t } = useTranslation();
  const label = kind === "fact"
    ? t("evidence.qa.segmentFact")
    : kind === "inference"
      ? t("evidence.qa.segmentInference")
      : t("evidence.qa.segmentUnknown");
  return <span className={`lens-ev-qa-segment-badge lens-ev-qa-segment-badge-${kind}`}>{label}</span>;
}

function SegmentedAnswer({
  segments,
  noAnswerReason,
  emptyLabel,
  answerSegmentsLabel,
  evidenceRefsLabel,
}: {
  segments: Array<{
    id: string;
    kind: EvidenceQuerySegment["kind"];
    text: string;
    evidenceRefs: Array<EvidenceRef | EvidenceQueryRef>;
  }>;
  noAnswerReason?: string;
  emptyLabel: string;
  answerSegmentsLabel: string;
  evidenceRefsLabel: string;
}) {
  if (segments.length === 0) {
    return <div className="lens-ev-qa-no-answer">{noAnswerReason ?? emptyLabel}</div>;
  }

  return (
    <div className="lens-ev-qa-segments" role="article" aria-label={answerSegmentsLabel}>
      {segments.map((segment) => (
        <div key={segment.id} className={`lens-ev-qa-segment lens-ev-qa-segment-${segment.kind}`}>
          <div className="lens-ev-qa-segment-line">
            <SegmentBadge kind={segment.kind} />
            <span className="lens-ev-qa-segment-text">{segment.text}</span>
          </div>
          <div className="lens-ev-qa-refs" aria-label={evidenceRefsLabel}>
            {segment.evidenceRefs.map((ref, i) => (
              <EvidenceRefLink key={`${ref.kind}-${ref.id}-${i}`} ref={ref} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function PreparedRead({ qa }: { qa: QABlock }) {
  const { t } = useTranslation();
  const initialSegments = qa.segments ?? [];

  if (initialSegments.length === 0 && !qa.answer.trim() && !qa.noAnswerReason) {
    return null;
  }

  return (
    <div className={`lens-ev-qa-answer lens-ev-qa-bubble lens-ev-qa-bubble-assistant${qa.status === "no_answer" ? " lens-ev-qa-answer-placeholder" : ""}`}>
      <div className="lens-ev-qa-bubble-role">{t("evidence.qa.preparedRead")}</div>
      <div className="lens-ev-qa-answer-head">
        <span className="lens-ev-qa-state-label">
          {qa.status === "no_answer" ? t("evidence.qa.noAnswer") : t("evidence.qa.preparedRead")}
        </span>
        {qa.noAnswerReason && initialSegments.length > 0 && (
          <span className="lens-ev-qa-answer-note">{qa.noAnswerReason}</span>
        )}
      </div>
      {initialSegments.length > 0 ? (
        <SegmentedAnswer
          segments={initialSegments}
          noAnswerReason={qa.noAnswerReason ?? undefined}
          emptyLabel={t("evidence.qa.noAnswer")}
          answerSegmentsLabel={t("evidence.qa.preparedSegmentsLabel")}
          evidenceRefsLabel={t("evidence.qa.evidenceRefsLabel")}
        />
      ) : qa.noAnswerReason ? (
        <div className="lens-ev-qa-no-answer">{qa.noAnswerReason}</div>
      ) : (
        <>
          <div>{qa.answer}</div>
          {qa.evidenceRefs.length > 0 && (
            <div className="lens-ev-qa-refs" aria-label={t("evidence.qa.evidenceRefsLabel")}>
              {qa.evidenceRefs.map((ref, i) => (
                <EvidenceRefLink key={`${ref.kind}-${ref.id}-${i}`} ref={ref} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function QAFrame({
  qa,
  inputValue,
  history,
  isSubmitting,
  onInputChange,
  onSubmitQuestion,
}: Props) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(inputValue);

  useEffect(() => {
    setDraft(inputValue);
  }, [inputValue]);

  function submit(question: string) {
    const trimmed = question.trim();
    if (!trimmed || isSubmitting) return;
    onSubmitQuestion(trimmed);
    setDraft("");
    onInputChange("");
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    submit(draft);
  }

  return (
    <div className="lens-ev-qa-frame" role="region" aria-label={t("evidence.qa.label")}>
      <form className="lens-ev-qa-form" onSubmit={handleSubmit}>
        <div className="lens-ev-qa-input-shell">
          <input
            className="lens-ev-qa-input"
            type="text"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              onInputChange(e.target.value);
            }}
            placeholder={t("evidence.qa.placeholder")}
            aria-label={t("evidence.qa.inputLabel")}
            disabled={isSubmitting}
          />
          <button
            className="lens-ev-qa-submit"
            type="submit"
            disabled={isSubmitting || draft.trim().length === 0}
            aria-label={isSubmitting ? t("evidence.qa.checking") : t("evidence.qa.ask")}
            title={isSubmitting ? t("evidence.qa.checking") : t("evidence.qa.ask")}
          >
            <ArrowUp size={14} strokeWidth={2.25} aria-hidden="true" />
          </button>
        </div>
      </form>

      <div className="lens-ev-qa-thread">
        <PreparedRead qa={qa} />

        {history.map((entry) => (
          <div key={entry.id} className="lens-ev-qa-exchange">
            <div className="lens-ev-qa-bubble lens-ev-qa-bubble-user">
              <div className="lens-ev-qa-bubble-role">{t("evidence.qa.you")}</div>
              <div className="lens-ev-qa-bubble-text">{entry.question}</div>
            </div>

            <div
              className={`lens-ev-qa-answer lens-ev-qa-bubble lens-ev-qa-bubble-assistant${entry.status === "failed" ? " lens-ev-qa-answer-placeholder" : ""}`}
              role={entry.status === "pending" ? "status" : entry.status === "failed" ? "alert" : "article"}
              aria-live={entry.status === "pending" ? "polite" : undefined}
            >
              <div className="lens-ev-qa-bubble-role">{t("evidence.qa.assistant")}</div>
              {entry.status === "pending" ? (
                <div className="lens-ev-qa-pending">{t("evidence.qa.checking")}</div>
              ) : entry.status === "failed" ? (
                <div className="lens-ev-qa-no-answer">{entry.error ?? t("evidence.qa.submitFailed")}</div>
              ) : (
                <>
                  <div className="lens-ev-qa-answer-head">
                    <span className="lens-ev-qa-state-label">
                      {entry.response?.status === "no_answer"
                        ? t("evidence.qa.noAnswer")
                        : t("evidence.qa.groundedAnswer")}
                    </span>
                    {entry.response?.noAnswerReason && (entry.response?.segments?.length ?? 0) > 0 && (
                      <span className="lens-ev-qa-answer-note">{entry.response.noAnswerReason}</span>
                    )}
                  </div>
                  <SegmentedAnswer
                    segments={entry.response?.segments ?? []}
                    noAnswerReason={entry.response?.noAnswerReason}
                    emptyLabel={t("evidence.qa.noAnswer")}
                    answerSegmentsLabel={t("evidence.qa.answerSegmentsLabel")}
                    evidenceRefsLabel={t("evidence.qa.evidenceRefsLabel")}
                  />
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
