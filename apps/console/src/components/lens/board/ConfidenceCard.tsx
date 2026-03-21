import type { ConfidenceSummary } from "../../../api/curated-types.js";

interface Props {
  confidence: ConfidenceSummary;
}

function scoreColorClass(value: number): string {
  if (value >= 0.7) return "lens-board-conf-score-high";
  if (value >= 0.4) return "lens-board-conf-score-mid";
  return "lens-board-conf-score-low";
}

export function ConfidenceCard({ confidence }: Props) {
  const pct = Math.round(confidence.value * 100);
  return (
    <div className="lens-board-card">
      <div className="lens-board-card-title">Confidence</div>
      <div className="lens-board-conf-top">
        <div
          className={`lens-board-conf-score ${scoreColorClass(confidence.value)}`}
          aria-label={`Confidence score: ${pct}%`}
        >
          {pct}%
        </div>
        <div className="lens-board-conf-meta">
          <span className="lens-board-conf-label">{confidence.label}</span>
          <span className="lens-board-conf-basis">{confidence.basis}</span>
        </div>
      </div>
      {confidence.risk && (
        <div className="lens-board-conf-risk">
          <span className="lens-board-conf-risk-label">Risk:</span> {confidence.risk}
        </div>
      )}
    </div>
  );
}
