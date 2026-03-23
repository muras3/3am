import type { ConfidenceSummary, CuratedState } from "../../../api/curated-types.js";
import { sectionFallback } from "./board-state.js";

interface Props {
  confidence: ConfidenceSummary;
  state: CuratedState;
}

function scoreColorClass(value: number): string {
  if (value >= 0.7) return "lens-board-conf-score-high";
  if (value >= 0.4) return "lens-board-conf-score-mid";
  return "lens-board-conf-score-low";
}

export function ConfidenceCard({ confidence, state }: Props) {
  const hasConfidence =
    confidence.label.trim().length > 0 || confidence.basis.trim().length > 0 || confidence.value > 0;
  const pct = Math.round(confidence.value * 100);
  const fallbackLabel = state.diagnosis === "pending"
    ? "Building confidence"
    : state.evidenceDensity === "sparse" || state.baseline !== "ready"
      ? "Limited confidence"
      : "Reviewing confidence";
  return (
    <div className="lens-board-card">
      <div className="lens-board-card-title">Confidence</div>
      <div className="lens-board-conf-top">
        <div
          className={`lens-board-conf-score ${scoreColorClass(confidence.value)}`}
          aria-label={hasConfidence ? `Confidence score: ${pct}%` : "Confidence unavailable"}
        >
          {hasConfidence ? `${pct}%` : "—"}
        </div>
        <div className="lens-board-conf-meta">
          <span className="lens-board-conf-label">
            {confidence.label.trim() || fallbackLabel}
          </span>
          <span className="lens-board-conf-basis">
            {confidence.basis.trim() || sectionFallback(state, "confidence")}
          </span>
        </div>
      </div>
      {confidence.risk.trim() ? (
        <div className="lens-board-conf-risk">
          <span className="lens-board-conf-risk-label">Risk:</span> {confidence.risk}
        </div>
      ) : (
        <div className="lens-board-conf-risk lens-board-conf-risk-empty">
          <span className="lens-board-conf-risk-label">Risk:</span> Early narrative can shift as more corroborating evidence lands.
        </div>
      )}
    </div>
  );
}
