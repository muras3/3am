import type { CuratedState } from "../../../api/curated-types.js";
import { sectionFallback } from "./board-state.js";
import { shortenForViewport } from "./viewport-text.js";

interface Props {
  hypothesis: string;
  state: CuratedState;
}

export function RootCauseHypothesis({ hypothesis, state }: Props) {
  const fullText = hypothesis.trim() || sectionFallback(state, "rootCause");
  const previewText = shortenForViewport(fullText, 170);
  const isShortened = previewText !== fullText;
  const isProvisional = state.diagnosis !== "ready" || state.evidenceDensity === "sparse";
  const heading = isProvisional ? "Working Theory" : "Root Cause Hypothesis";
  const statusCopy = isProvisional
    ? "Unconfirmed"
    : "Correlated";

  return (
    <div className="lens-board-root-cause">
      <div className="lens-board-root-cause-head">
        <h2 className="lens-board-section-label">{heading}</h2>
        <span className={`lens-board-state-chip${isProvisional ? "" : " lens-board-state-chip-confirmed"}`}>
          {statusCopy}
        </span>
      </div>
      <p className="lens-board-root-cause-text" title={fullText}>{previewText}</p>
      {isShortened ? (
        <details className="lens-board-inline-details">
          <summary>{isProvisional ? "Full working theory" : "Full root cause"}</summary>
          <div className="lens-board-inline-details-body">{fullText}</div>
        </details>
      ) : null}
    </div>
  );
}
