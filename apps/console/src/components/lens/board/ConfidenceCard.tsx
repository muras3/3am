import type { ConfidenceSummary, CuratedState } from "../../../api/curated-types.js";
import { sectionFallback } from "./board-state.js";
import { shortenForViewport } from "./viewport-text.js";

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
  const basisText = confidence.basis.trim() || sectionFallback(state, "confidence");
  const riskText =
    confidence.risk.trim() ||
    "Early narrative can shift as more corroborating evidence lands.";
  const basisPreview = shortenForViewport(basisText, 46);
  const riskPreview = shortenForViewport(riskText, 88);
  const hasExpandableDetail = basisPreview !== basisText || riskPreview !== riskText;
  const confidenceStatus = state.diagnosis === "ready" ? "Current confidence" : "Confidence now";

  return (
    <div className="lens-board-card">
      <div className="lens-board-card-title">{confidenceStatus}</div>
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
            {basisPreview}
          </span>
        </div>
      </div>
      <div className="lens-board-conf-row">
        <span className="lens-board-conf-row-label">Based on</span>
        <span className="lens-board-conf-row-value">{basisPreview}</span>
      </div>
      <div className="lens-board-conf-risk">
        <span className="lens-board-conf-risk-label">Uncertainty:</span> {riskPreview}
      </div>
      {hasExpandableDetail ? (
        <details className="lens-board-inline-details">
          <summary>Confidence details</summary>
          <div className="lens-board-inline-details-body lens-board-action-detail-copy">
            <div>
              <strong>Basis:</strong> {basisText}
            </div>
            <div>
              <strong>Risk:</strong> {riskText}
            </div>
          </div>
        </details>
      ) : null}
    </div>
  );
}
