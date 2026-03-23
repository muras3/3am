import type { CuratedState, EvidenceCounts, ImpactSummary } from "../../../api/curated-types.js";
import type { LensLevel } from "../../../routes/__root.js";
import { sectionFallback } from "./board-state.js";

interface Props {
  counts: EvidenceCounts;
  impact: ImpactSummary;
  state: CuratedState;
  zoomTo: (level: LensLevel, trigger?: HTMLElement, incidentId?: string) => void;
}

function formatTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toISOString().slice(11, 19) + " UTC";
}

export function LensEvidenceEntry({ counts, impact, state, zoomTo }: Props) {
  const showStateNote =
    state.diagnosis !== "ready" || state.baseline !== "ready" || state.evidenceDensity !== "rich";

  function handleClick(e: React.MouseEvent<HTMLButtonElement>) {
    zoomTo(2, e.currentTarget);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      zoomTo(2, e.currentTarget);
    }
  }

  return (
    <div className="lens-board-card lens-board-evidence-entry">
      <div className="lens-board-evidence-header">
        <div className="lens-board-card-title">Evidence</div>
        <div className="lens-board-evidence-timestamps">
          <span>Started {formatTime(impact.startedAt)}</span>
          <span>Full cascade {formatTime(impact.fullCascadeAt)}</span>
          <span>Diagnosed {formatTime(impact.diagnosedAt)}</span>
        </div>
      </div>

      <div className="lens-board-evidence-counts">
        <div className="lens-board-evidence-row">
          <span className="lens-board-ev-label">Traces</span>
          <span className="lens-board-ev-value">
            {counts.traces}
            {counts.traceErrors > 0 && (
              <span className="lens-board-ev-errors"> ({counts.traceErrors} errors)</span>
            )}
          </span>
        </div>
        <div className="lens-board-evidence-row">
          <span className="lens-board-ev-label">Metrics</span>
          <span className="lens-board-ev-value">{counts.metrics} anomalous</span>
        </div>
        <div className="lens-board-evidence-row">
          <span className="lens-board-ev-label">Logs</span>
          <span className="lens-board-ev-value">
            {counts.logs}
            {counts.logErrors > 0 && (
              <span className="lens-board-ev-errors"> ({counts.logErrors} errors)</span>
            )}
          </span>
        </div>
      </div>
      {showStateNote ? (
        <div className="lens-board-evidence-note">{sectionFallback(state, "evidence")}</div>
      ) : null}

      <button
        className="lens-board-btn-evidence"
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        aria-label="Open Evidence Studio"
      >
        <span className="lens-board-ev-dot" aria-hidden="true" />
        Open Evidence Studio now
      </button>
    </div>
  );
}
