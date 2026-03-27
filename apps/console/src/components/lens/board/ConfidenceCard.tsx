import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  const hasConfidence =
    confidence.label.trim().length > 0 || confidence.basis.trim().length > 0 || confidence.value > 0;
  const pct = Math.round(confidence.value * 100);
  const fallbackLabel = state.diagnosis === "pending"
    ? t("board.confidence.buildingConfidence")
    : state.evidenceDensity === "sparse" || state.baseline !== "ready"
      ? t("board.confidence.limitedConfidence")
      : t("board.confidence.reviewingConfidence");
  const basisText = confidence.basis.trim() || sectionFallback(state, "confidence");
  const riskText =
    confidence.risk.trim() ||
    t("board.confidence.defaultRisk");
  const basisPreview = shortenForViewport(basisText, 46);
  const riskPreview = shortenForViewport(riskText, 88);
  const hasExpandableDetail = basisPreview !== basisText || riskPreview !== riskText;
  const confidenceStatus = state.diagnosis === "ready" ? t("board.confidence.title") : t("board.confidence.titlePending");

  return (
    <div className="lens-board-card">
      <div className="lens-board-card-title">{confidenceStatus}</div>
      <div className="lens-board-conf-top">
        <div
          className={`lens-board-conf-score ${scoreColorClass(confidence.value)}`}
          aria-label={hasConfidence ? t("board.confidence.scoreLabel", { pct }) : t("board.confidence.scoreUnavailable")}
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
        <span className="lens-board-conf-row-label">{t("board.confidence.basedOn")}</span>
        <span className="lens-board-conf-row-value">{basisPreview}</span>
      </div>
      <div className="lens-board-conf-risk">
        <span className="lens-board-conf-risk-label">{t("board.confidence.uncertainty")}</span> {riskPreview}
      </div>
      {hasExpandableDetail ? (
        <details className="lens-board-inline-details">
          <summary>{t("board.confidence.details")}</summary>
          <div className="lens-board-inline-details-body lens-board-action-detail-copy">
            <div>
              <strong>{t("board.confidence.basisLabel")}</strong> {basisText}
            </div>
            <div>
              <strong>{t("board.confidence.riskLabel")}</strong> {riskText}
            </div>
          </div>
        </details>
      ) : null}
    </div>
  );
}
