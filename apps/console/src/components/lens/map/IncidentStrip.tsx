import type { MapIncident } from "../../../api/curated-types.js";
import type { LensLevel } from "../../../routes/__root.js";

interface Props {
  incidents: MapIncident[];
  zoomTo: (level: LensLevel, trigger?: HTMLElement) => void;
}

/**
 * IncidentStrip — list of active incident rows below the map.
 * Each row is clickable → zooms to Level 1 (Incident Board).
 */
export function IncidentStrip({ incidents, zoomTo }: Props) {
  if (incidents.length === 0) {
    return (
      <div className="incident-strip" data-testid="incident-strip">
        <p style={{ color: "var(--ink-3)", fontSize: "var(--fs-sm)", padding: "8px 14px" }}>
          No active incidents.
        </p>
      </div>
    );
  }

  return (
    <div className="incident-strip" data-testid="incident-strip">
      {incidents.map((incident) => (
        <IncidentRow key={incident.incidentId} incident={incident} zoomTo={zoomTo} />
      ))}
    </div>
  );
}

function IncidentRow({
  incident,
  zoomTo,
}: {
  incident: MapIncident;
  zoomTo: (level: LensLevel, trigger?: HTMLElement) => void;
}) {
  const sevNorm = incident.severity.toLowerCase();

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    zoomTo(1, e.currentTarget);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      zoomTo(1, e.currentTarget as HTMLElement);
    }
  }

  return (
    <div
      className="incident-row"
      tabIndex={0}
      role="button"
      aria-label={`Open incident ${incident.incidentId}: ${incident.label}`}
      data-testid={`incident-row-${incident.incidentId}`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <span className={`health-dot ${sevNorm === "critical" || sevNorm === "high" ? "critical" : sevNorm === "medium" ? "degraded" : ""}`} />
      <span className="ir-id">{incident.incidentId.replace("inc_", "INC-").toUpperCase()}</span>
      <span className="ir-name">{incident.label}</span>
      <span className={`ir-sev ${sevNorm}`}>{incident.severity}</span>
      <span className="ir-time">{incident.openedAgo} ago</span>
    </div>
  );
}
