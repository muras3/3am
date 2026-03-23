import { useNavigate, useSearch } from "@tanstack/react-router";
import type { QABlock, EvidenceRef } from "../../../api/curated-types.js";
import type { LensSearchParams } from "../../../routes/__root.js";

interface Props {
  qa: QABlock | null;
  diagnosisState?: "ready" | "pending" | "unavailable";
}

function EvidenceRefLink({ ref: evidenceRef }: { ref: EvidenceRef }) {
  const navigate = useNavigate();
  const search = useSearch({ from: "__root__" }) as LensSearchParams;

  function handleClick() {
    const tabMap: Record<string, "traces" | "metrics" | "logs"> = {
      span: "traces",
      metric: "metrics",
      log: "logs",
      metric_group: "metrics",
      log_cluster: "logs",
    };
    const tab = tabMap[evidenceRef.kind] ?? search.tab;
    const targetId = evidenceRef.kind === "span"
      ? evidenceRef.id.split(":").at(-1) ?? evidenceRef.id
      : evidenceRef.id;
    void navigate({
      to: "/",
      search: { ...search, tab, targetId },
      replace: true,
    });

    // Apply highlight after delay — use data-target-id for concrete refs
    setTimeout(() => {
      document.querySelectorAll(".proof-highlight").forEach((el) => {
        el.classList.remove("proof-highlight");
      });
      const targets = document.querySelectorAll(`[data-target-id="${targetId}"]`);
      targets.forEach((el) => el.classList.add("proof-highlight"));
      const first = targets[0];
      if (first) first.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 200);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleClick();
    }
  }

  return (
    <span
      role="button"
      tabIndex={0}
      className="lens-ev-qa-ref"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      aria-label={`View evidence: ${evidenceRef.kind} ${evidenceRef.id}`}
    >
      {evidenceRef.kind}:{evidenceRef.id}
    </span>
  );
}

/**
 * QAFrame — Question / Answer block above tabs.
 * Shows question + teal-soft answer box + evidence refs + follow-up chips.
 * When qa is null or has noAnswerReason, shows degraded state.
 */
export function QAFrame({ qa, diagnosisState }: Props) {
  if (!qa) {
    const question = diagnosisState === "unavailable"
      ? "Why is this incident degraded?"
      : "What evidence is available for this incident?";
    const message = diagnosisState === "ready"
      ? "Narrative is being generated. Evidence surfaces are available below."
      : diagnosisState === "unavailable"
        ? "Diagnosis is unavailable. Use the deterministic traces, metrics, and logs below."
        : "Diagnosis not available yet. Evidence is being collected.";
    return (
      <div className="lens-ev-qa-frame lens-ev-qa-empty" role="region" aria-label="Question and answer">
        <div className="lens-ev-qa-question-row">
          <span className="lens-ev-qa-icon" aria-hidden="true">?</span>
          <span className="lens-ev-qa-question-text">{question}</span>
        </div>
        <div className="lens-ev-qa-answer lens-ev-qa-answer-placeholder">
          <strong>Answer:</strong> {message}
          <div className="lens-ev-qa-evidence-note">
            The Evidence Studio surfaces remain available below even without a narrative answer.
          </div>
        </div>
        <div className="lens-ev-qa-followups" role="group" aria-label="Follow-up questions">
          <span className="lens-ev-qa-chip lens-ev-qa-chip-placeholder">Open traces</span>
          <span className="lens-ev-qa-chip lens-ev-qa-chip-placeholder">Check metrics drift</span>
          <span className="lens-ev-qa-chip lens-ev-qa-chip-placeholder">Inspect logs</span>
        </div>
      </div>
    );
  }

  if (qa.noAnswerReason) {
    return (
      <div className="lens-ev-qa-frame" role="region" aria-label="Question and answer">
        <div className="lens-ev-qa-question-row">
          <span className="lens-ev-qa-icon" aria-hidden="true">?</span>
          <span className="lens-ev-qa-question-text">{qa.question}</span>
        </div>
        <div className="lens-ev-qa-no-answer">
          {qa.noAnswerReason}
        </div>
      </div>
    );
  }

  const { traces, metrics, logs } = qa.evidenceSummary;
  const evidenceSummaryText = [
    traces > 0 ? `${traces} traces` : null,
    metrics > 0 ? `${metrics} metrics` : null,
    logs > 0 ? `${logs} logs` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="lens-ev-qa-frame" role="region" aria-label="Question and answer">
      {/* Question row */}
      <div className="lens-ev-qa-question-row">
        <span className="lens-ev-qa-icon" aria-hidden="true">?</span>
        <span className="lens-ev-qa-question-text">{qa.question}</span>
        {qa.evidenceSummary && (
          <span className="lens-ev-qa-time" aria-label="Evidence summary">
            {evidenceSummaryText}
          </span>
        )}
      </div>

      {/* Answer block */}
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

      {/* Follow-up chips */}
      {qa.followups.length > 0 && (
        <div className="lens-ev-qa-followups" role="group" aria-label="Follow-up questions">
          {qa.followups.map((q) => (
            <button
              key={q.question}
              className="lens-ev-qa-chip"
              type="button"
              // noop per plan — follow-up transport not yet defined
              onClick={() => undefined}
            >
              {q.question}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
