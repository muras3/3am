import type { BlastRadiusEntry, CuratedState } from "../../../api/curated-types.js";
import { sectionFallback } from "./board-state.js";

interface Props {
  entries: BlastRadiusEntry[];
  state: CuratedState;
}

function statusModifier(status: BlastRadiusEntry["status"]): string {
  if (status === "critical") return "critical";
  if (status === "degraded") return "degraded";
  return "healthy";
}

export function BlastRadius({ entries, state }: Props) {
  return (
    <div className="lens-board-card">
      <div className="lens-board-card-title">Blast Radius</div>
      <div className="lens-board-blast-rows">
        {entries.length > 0 ? entries.map((entry, i) => (
          <div key={i} className="lens-board-blast-row">
            <span
              className={`lens-board-health-dot lens-board-health-dot-${statusModifier(entry.status)}`}
              aria-label={entry.status}
            />
            <span className="lens-board-blast-target">{entry.target}</span>
            <div className="lens-board-blast-bar" aria-hidden="true">
              <div
                className={`lens-board-blast-fill lens-board-blast-fill-${statusModifier(entry.status)}`}
                style={{ width: `${Math.round(entry.impactValue * 100)}%` }}
              />
            </div>
            <span className={`lens-board-blast-pct lens-board-blast-pct-${statusModifier(entry.status)}`}>
              {entry.label}
            </span>
          </div>
        )) : (
          <div className="lens-board-empty-block">{sectionFallback(state, "blastRadius")}</div>
        )}
      </div>
    </div>
  );
}
