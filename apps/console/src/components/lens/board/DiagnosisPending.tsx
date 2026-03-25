interface Props {
  status: "pending" | "unavailable";
  message?: string;
  subtext?: string;
  confirmedNow?: string[];
  notYetConfirmed?: string[];
  nextSteps?: string[];
  onOpenEvidence?: (trigger?: HTMLElement) => void;
  onRerunDiagnosis?: () => void;
  rerunDisabled?: boolean;
  rerunLabel?: string;
  rerunNote?: string;
}

export function DiagnosisPending({
  status,
  message,
  subtext,
  confirmedNow = [],
  notYetConfirmed = [],
  nextSteps = [],
  onOpenEvidence,
  onRerunDiagnosis,
  rerunDisabled = true,
  rerunLabel = "Re-run diagnosis",
  rerunNote,
}: Props) {
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
          <div className="lens-board-pending-panel-title">Confirmed now</div>
          <ul className="lens-board-pending-list">
            {confirmedNow.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>

        <div className="lens-board-pending-panel lens-board-pending-panel-muted">
          <div className="lens-board-pending-panel-title">Not confirmed yet</div>
          <ul className="lens-board-pending-list">
            {notYetConfirmed.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </div>

      <div className="lens-board-pending-operator">
        <div className="lens-board-pending-panel lens-board-pending-panel-strong">
          <div className="lens-board-pending-panel-title">Operator next step</div>
          <ul className="lens-board-pending-list">
            {nextSteps.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>

        <div className="lens-board-pending-actions">
          <button
            type="button"
            className="lens-board-btn-evidence lens-board-btn-evidence-secondary"
            aria-label="Open Evidence Studio from diagnosis status"
            onClick={(event) => onOpenEvidence?.(event.currentTarget)}
          >
            Open Evidence Studio first
          </button>
          <button
            type="button"
            className="lens-board-btn-evidence lens-board-btn-evidence-tertiary"
            disabled={rerunDisabled}
            aria-describedby="lens-board-rerun-note"
            onClick={onRerunDiagnosis}
          >
            {rerunLabel}
          </button>
          <p id="lens-board-rerun-note" className="lens-board-pending-note">
            {rerunNote ?? (
              status === "pending"
                ? "Diagnosis is already running. Stay on the evidence lanes until this run finishes."
                : "Use this to request one new diagnosis run from the current incident evidence."
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
