import type { CuratedState, IncidentAction } from "../../../api/curated-types.js";
import { sectionFallback } from "./board-state.js";
import { shortenForViewport, splitActionForViewport } from "./viewport-text.js";

interface Props {
  action: IncidentAction;
  state: CuratedState;
}

export function ImmediateAction({ action, state }: Props) {
  const text = action.text.trim() || sectionFallback(state, "action");
  const rationale =
    action.rationale.trim() || sectionFallback(state, "action");
  const doNot = action.doNot.trim();
  const actionSteps = splitActionForViewport(text);
  const rationalePreview = shortenForViewport(rationale, 110);
  const doNotText = doNot || "No contrary guidance returned.";
  const doNotPreview = shortenForViewport(doNotText, 110);
  const showFullDetails =
    actionSteps.join(" ").trim() !== text ||
    rationalePreview !== rationale ||
    doNotPreview !== doNotText;

  return (
    <div className="lens-board-action-hero">
      <div className="lens-board-action-eyebrow">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="14" height="14">
          <path
            d="M8 1l2.5 5 5.5.8-4 3.9.9 5.3L8 13.3 3.1 16l.9-5.3-4-3.9 5.5-.8z"
            fill="currentColor"
          />
        </svg>
        Immediate Action
      </div>
      <div className="lens-board-action-steps" role="list" aria-label="Immediate action steps">
        {actionSteps.map((step, index) => (
          <div key={`${step}-${index}`} className="lens-board-action-step" role="listitem">
            <span className="lens-board-action-step-index">{index + 1}</span>
            <span className="lens-board-action-step-text">{step}</span>
          </div>
        ))}
      </div>
      <div className="lens-board-action-support-grid">
        <div className="lens-board-action-support">
          <strong>Why</strong>
          <span title={rationale}>{rationalePreview}</span>
        </div>
        <div
          className={`lens-board-action-support lens-board-action-donot${doNot ? "" : " lens-board-action-donot-empty"}`}
        >
          <strong>Do not</strong>
          <span title={doNotText}>{doNotPreview}</span>
        </div>
      </div>
      {showFullDetails ? (
        <details className="lens-board-inline-details lens-board-inline-details-strong">
          <summary>Full action details</summary>
          <div className="lens-board-inline-details-body lens-board-action-detail-copy">
            <div>
              <strong>Action:</strong> {text}
            </div>
            <div>
              <strong>Why:</strong> {rationale}
            </div>
            <div>
              <strong>Do not:</strong> {doNotText}
            </div>
          </div>
        </details>
      ) : null}
    </div>
  );
}
