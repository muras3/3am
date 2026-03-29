import { useTranslation } from "react-i18next";
import type { ConfidenceSummary, CuratedState, ExtendedIncident } from "../../../api/curated-types.js";
import { formatShortIncidentId } from "../../../lib/incidentId.js";
import { describeBoardState, sectionFallback } from "./board-state.js";
import { shortenForViewport } from "./viewport-text.js";

interface Props {
  incidentId: string;
  status: ExtendedIncident["status"];
  closedAt?: string;
  severity: string;
  headline: string;
  chips: ExtendedIncident["chips"];
  state: CuratedState;
  confidence?: ConfidenceSummary;
}

function confidenceColorClass(value: number): string {
  if (value >= 0.7) return "lens-board-conf-badge-high";
  if (value >= 0.4) return "lens-board-conf-badge-mid";
  return "lens-board-conf-badge-low";
}

export function WhatHappened({ incidentId, status, closedAt, severity, headline, chips, state, confidence }: Props) {
  const { t } = useTranslation();
  const displayHeadline = headline.trim() || sectionFallback(state, "headline");
  const viewportHeadline = shortenForViewport(displayHeadline, 72);
  const showStateNote =
    state.diagnosis !== "ready" || state.baseline !== "ready" || state.evidenceDensity !== "rich";
  const headlineShortened = viewportHeadline !== displayHeadline;

  const hasConfidence = confidence && (
    confidence.label.trim().length > 0 || confidence.basis.trim().length > 0 || confidence.value > 0
  );
  const confPct = confidence ? Math.round(confidence.value * 100) : 0;

  return (
    <div className="lens-board-identity">
      <div className="lens-board-identity-meta">
        <span className="lens-board-id">{formatShortIncidentId(incidentId)}</span>
        <span className={`lens-board-sev lens-board-sev-${severity}`}>{severity}</span>
        {status === "closed" ? (
          <span className="lens-board-status-pill" title={closedAt ? `Closed at ${closedAt}` : "Closed"}>
            Closed
          </span>
        ) : null}
      </div>
      <div className="lens-board-headline-row">
        <h1 className="lens-board-headline" title={displayHeadline}>
          {viewportHeadline}
        </h1>
        {hasConfidence ? (
          <div
            className={`lens-board-conf-block ${confidenceColorClass(confidence.value)}`}
            aria-label={t("board.confidence.scoreLabel", { pct: confPct })}
          >
            <span className="lens-board-conf-block-pct">{confPct}%</span>
            <span className="lens-board-conf-block-label">
              {confidence.label.trim() || ""}
            </span>
          </div>
        ) : null}
      </div>
      {chips.length > 0 && (
        <div className="lens-board-chips">
          {chips.map((chip: ExtendedIncident["chips"][number], i: number) => (
            <span key={i} className={`lens-board-chip lens-board-chip-${chip.type}`}>
              {chip.label}
            </span>
          ))}
        </div>
      )}
      {headlineShortened ? (
        <details className="lens-board-inline-details">
          <summary>{t("board.whatHappened.fullHeadline")}</summary>
          <div className="lens-board-inline-details-body">{displayHeadline}</div>
        </details>
      ) : null}
      {showStateNote ? (
        <p className="lens-board-state-note">{describeBoardState(state)}</p>
      ) : null}
    </div>
  );
}
