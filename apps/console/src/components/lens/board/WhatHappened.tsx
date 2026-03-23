import type { CuratedState, ExtendedIncident } from "../../../api/curated-types.js";
import { formatShortIncidentId } from "../../../lib/incidentId.js";
import { describeBoardState, sectionFallback } from "./board-state.js";
import { shortenForViewport } from "./viewport-text.js";

interface Props {
  incidentId: string;
  severity: string;
  headline: string;
  chips: ExtendedIncident["chips"];
  state: CuratedState;
}

export function WhatHappened({ incidentId, severity, headline, chips, state }: Props) {
  const displayHeadline = headline.trim() || sectionFallback(state, "headline");
  const viewportHeadline = shortenForViewport(displayHeadline, 72);
  const showStateNote =
    state.diagnosis !== "ready" || state.baseline !== "ready" || state.evidenceDensity !== "rich";
  const headlineShortened = viewportHeadline !== displayHeadline;

  return (
    <div className="lens-board-identity">
      <div className="lens-board-identity-meta">
        <span className="lens-board-id">{formatShortIncidentId(incidentId)}</span>
        <span className={`lens-board-sev lens-board-sev-${severity}`}>{severity}</span>
      </div>
      <h1 className="lens-board-headline" title={displayHeadline}>
        {viewportHeadline}
      </h1>
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
          <summary>Full headline</summary>
          <div className="lens-board-inline-details-body">{displayHeadline}</div>
        </details>
      ) : null}
      {showStateNote ? (
        <p className="lens-board-state-note">{describeBoardState(state)}</p>
      ) : null}
    </div>
  );
}
