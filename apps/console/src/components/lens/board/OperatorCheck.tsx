import type { CuratedState } from "../../../api/curated-types.js";
import { sectionFallback } from "./board-state.js";

interface Props {
  checks: string[];
  state: CuratedState;
}

export function OperatorCheck({ checks, state }: Props) {
  const visibleChecks = checks.slice(0, 2);
  const hiddenChecks = checks.slice(visibleChecks.length);

  return (
    <div className="lens-board-card">
      <div className="lens-board-card-title">Operator Check</div>
      <ul className="lens-board-checklist" role="list">
        {checks.length > 0 ? visibleChecks.map((item, i) => (
          <li key={i} className="lens-board-check-item">
            <label className="lens-board-check-label">
              <input type="checkbox" className="lens-board-checkbox" />
              <span>{item}</span>
            </label>
          </li>
        )) : (
          <li className="lens-board-check-item">
            <div className="lens-board-empty-block">{sectionFallback(state, "checks")}</div>
          </li>
        )}
      </ul>
      {hiddenChecks.length > 0 ? (
        <details className="lens-board-inline-details">
          <summary>Show all checks ({checks.length})</summary>
          <div className="lens-board-inline-details-body lens-board-compact-list">
            {checks.map((item, index) => (
              <div key={`${item}-${index}`}>{item}</div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
