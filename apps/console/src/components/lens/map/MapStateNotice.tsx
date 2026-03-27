import { useTranslation } from "react-i18next";
import type { RuntimeMapState } from "../../../api/curated-types.js";

interface Props {
  state: RuntimeMapState;
  activeIncidents: number;
}

export function MapStatusBanner({ state }: Pick<Props, "state">) {
  const { t } = useTranslation();

  if (state.source !== "incident_scope") return null;

  return (
    <div className="map-status-banner" data-testid="map-status-banner">
      <span className="map-status-kicker">{t("map.statusBanner.liveWindowEmpty")}</span>
      <strong>{t("map.statusBanner.showingSpans", { window: state.windowLabel })}</strong>
      <span>{t("map.statusBanner.incidentScopedFallback")}</span>
    </div>
  );
}

export function MapEmptyState({ state, activeIncidents }: Props) {
  const { t } = useTranslation();

  const hasIncidents = activeIncidents > 0;
  const title = hasIncidents
    ? t("map.empty.noRecentSpansWithIncidents")
    : t("map.empty.noSpansYet");
  const detail = hasIncidents
    ? t("map.empty.detailWithIncidents")
    : t("map.empty.detailNoIncidents");
  const reason = state.emptyReason === "no_preserved_incident_spans"
    ? t("map.empty.noPreservedSpans")
    : hasIncidents
    ? t("map.empty.noIncidentFallback")
    : t("map.empty.noOpenIncidents");

  return (
    <div className="map-empty-shell" data-testid="map-empty-state">
      <div className="map-empty-copy">
        <span className="map-empty-kicker">{t("map.empty.observedFromSpans")}</span>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
      <div className="map-empty-meta" aria-label="Map empty state details">
        <span>{t("map.empty.noLiveTopology", { window: state.windowLabel })}</span>
        <span>{t("map.empty.openIncidents", { count: activeIncidents })}</span>
        <span>{reason}</span>
      </div>
    </div>
  );
}
