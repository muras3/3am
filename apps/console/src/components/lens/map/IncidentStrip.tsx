import { useTranslation } from "react-i18next";
import type { MapIncident } from "../../../api/curated-types.js";
import type { LensLevel } from "../../../routes/__root.js";
import { formatShortIncidentId } from "../../../lib/incidentId.js";

interface Props {
  incidents: MapIncident[];
  zoomTo: (level: LensLevel, trigger?: HTMLElement, incidentId?: string) => void;
}

/**
 * IncidentStrip — list of active incident rows below the map.
 * Each row is clickable → zooms to Level 1 (Incident Board).
 */
export function IncidentStrip({ incidents, zoomTo }: Props) {
  const { t } = useTranslation();

  if (incidents.length === 0) {
    return (
      <div className="incident-strip" data-testid="incident-strip">
        <div className="incident-row incident-row-empty" data-testid="incident-row-empty">
          <span className="health-dot" aria-hidden="true" />
          <span className="ir-id">{t("map.incident.stateLabel")}</span>
          <span className="ir-name">{t("map.incident.noActive")}</span>
          <span className="ir-sev empty">{t("map.incident.ready")}</span>
          <span className="ir-time">{t("map.incident.noOpen")}</span>
        </div>
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
  zoomTo: (level: LensLevel, trigger?: HTMLElement, incidentId?: string) => void;
}) {
  const { t } = useTranslation();
  const sevNorm = incident.severity.toLowerCase();

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    zoomTo(1, e.currentTarget, incident.incidentId);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      zoomTo(1, e.currentTarget as HTMLElement, incident.incidentId);
    }
  }

  return (
    <div
      className="incident-row"
      tabIndex={0}
      role="button"
      aria-label={t("map.incident.openLabel", { id: incident.incidentId, label: incident.label })}
      data-testid={`incident-row-${incident.incidentId}`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <span className={`health-dot ${sevNorm === "critical" || sevNorm === "high" ? "critical" : sevNorm === "medium" ? "degraded" : ""}`} />
      <span className="ir-id">{formatShortIncidentId(incident.incidentId)}</span>
      <span className="ir-name">{incident.label}</span>
      <span className={`ir-sev ${sevNorm}`}>{incident.severity}</span>
      <span className="ir-time">{t("map.incident.ago", { time: incident.openedAgo })}</span>
    </div>
  );
}
