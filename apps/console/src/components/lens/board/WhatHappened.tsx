import type { ExtendedIncident } from "../../../api/curated-types.js";

interface Props {
  incidentId: string;
  severity: string;
  headline: string;
  chips: ExtendedIncident["chips"];
}

export function WhatHappened({ incidentId, severity, headline, chips }: Props) {
  return (
    <div className="lens-board-identity">
      <div className="lens-board-identity-meta">
        <span className="lens-board-id">{incidentId}</span>
        <span className={`lens-board-sev lens-board-sev-${severity}`}>{severity}</span>
      </div>
      <h1 className="lens-board-headline">{headline}</h1>
      {chips.length > 0 && (
        <div className="lens-board-chips">
          {chips.map((chip, i) => (
            <span key={i} className={`lens-board-chip lens-board-chip-${chip.type}`}>
              {chip.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
