interface Props {
  message?: string;
  subtext?: string;
  availableNow?: string[];
  nextUp?: string[];
}

export function DiagnosisPending({ message, subtext, availableNow = [], nextUp = [] }: Props) {
  return (
    <div className="lens-board-pending" role="status" aria-live="polite">
      <div className="lens-board-pending-head">
        <div className="lens-board-pending-pulse" aria-hidden="true" />
        <div className="lens-board-pending-copy">
          <p className="lens-board-pending-kicker">Diagnosis status</p>
          <p className="lens-board-pending-text">{message ?? "Diagnosis in progress"}</p>
          <p className="lens-board-pending-sub">
            {subtext ?? "The incident is visible now. The diagnosis narrative usually follows once evidence links settle."}
          </p>
        </div>
      </div>

      <div className="lens-board-pending-columns">
        <div className="lens-board-pending-panel">
          <div className="lens-board-pending-panel-title">Visible now</div>
          <ul className="lens-board-pending-list">
            {availableNow.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>

        <div className="lens-board-pending-panel lens-board-pending-panel-muted">
          <div className="lens-board-pending-panel-title">Still preparing</div>
          <ul className="lens-board-pending-list">
            {nextUp.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
