import type { IncidentAction } from "../../../api/curated-types.js";

interface Props {
  action: IncidentAction;
}

export function ImmediateAction({ action }: Props) {
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
      <div className="lens-board-action-text">{action.text}</div>
      <div className="lens-board-action-why">
        <strong>Why:</strong> {action.rationale}
      </div>
      {action.doNot && (
        <div className="lens-board-action-donot">
          <strong>Do not:</strong> {action.doNot}
        </div>
      )}
    </div>
  );
}
