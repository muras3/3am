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

  return (
    <div className="lens-board-root-cause">
      <h2 className="lens-board-section-label">Root Cause Hypothesis</h2>
      <p className="lens-board-root-cause-text" title={fullText}>{previewText}</p>
      {isShortened ? (
        <details className="lens-board-inline-details">
          <summary>Full root cause</summary>
          <div className="lens-board-inline-details-body">{fullText}</div>
        </details>
      ) : null}
    </div>
  );
}
