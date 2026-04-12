import { useTranslation } from "react-i18next";
import type { ConfidenceSummary, CuratedState } from "../../../api/curated-types.js";
import { sectionFallback } from "./board-state.js";
import { shortenForViewport } from "./viewport-text.js";

interface Props {
  hypothesis: string;
  state: CuratedState;
  confidence?: ConfidenceSummary;
}

function formatBasis(text: string): string {
  return text.replace(/\br=([0-9.]+)/g, "correlation=$1");
}

export function RootCauseHypothesis({ hypothesis, state, confidence }: Props) {
  const { t } = useTranslation();
  const fullText = hypothesis.trim() || sectionFallback(state, "rootCause");
  const previewText = shortenForViewport(fullText, 400);
  const isShortened = previewText !== fullText;
  const isProvisional = state.diagnosis !== "ready" || state.evidenceDensity === "sparse";
  const heading = isProvisional ? t("board.rootCause.titleProvisional") : t("board.rootCause.title");
  const statusCopy = isProvisional
    ? t("board.rootCause.statusProvisional")
    : t("board.rootCause.statusConfirmed");

  const basisText = formatBasis(confidence?.basis.trim() || "");
  const riskText = confidence?.risk.trim() || "";
  const hasConfidenceDetail = basisText.length > 0 || riskText.length > 0;

  return (
    <div className="lens-board-root-cause">
      <div className="lens-board-root-cause-head">
        <h2 className="lens-board-section-label">{heading}</h2>
        <span className={`lens-board-state-chip${isProvisional ? "" : " lens-board-state-chip-confirmed"}`}>
          {statusCopy}
        </span>
      </div>
      <p className="lens-board-root-cause-text" title={fullText}>{previewText}</p>
      {hasConfidenceDetail ? (
        <div className="lens-board-root-cause-conf">
          {basisText ? (
            <div className="lens-board-conf-row">
              <span className="lens-board-conf-row-label">{t("board.confidence.basedOn")}</span>
              <span className="lens-board-conf-row-value">{basisText}</span>
            </div>
          ) : null}
          {riskText ? (
            <div className="lens-board-conf-risk">
              <span className="lens-board-conf-risk-label">{t("board.confidence.uncertainty")}</span> {riskText}
            </div>
          ) : null}
        </div>
      ) : null}
      {isShortened ? (
        <details className="lens-board-inline-details">
          <summary>{isProvisional ? t("board.rootCause.fullWorkingTheory") : t("board.rootCause.fullRootCause")}</summary>
          <div className="lens-board-inline-details-body">{fullText}</div>
        </details>
      ) : null}
    </div>
  );
}
