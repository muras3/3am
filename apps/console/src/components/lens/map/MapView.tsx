import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { curatedQueries } from "../../../api/queries.js";
import type { LensLevel } from "../../../routes/__root.js";
import { StatsBar } from "./StatsBar.js";
import { MapGraph } from "./MapGraph.js";
import { IncidentStrip } from "./IncidentStrip.js";
import { MapEmptyState, MapStatusBanner } from "./MapStateNotice.js";

interface Props {
  zoomTo: (level: LensLevel, trigger?: HTMLElement, incidentId?: string) => void;
}

/**
 * MapView — Level 0 orchestration component.
 *
 * Renders:
 * 1. StatsBar — 4 cluster metrics
 * 2. Section title + MapGraph — 3-zone dependency map (services / edges / dependencies)
 * 3. Section title + IncidentStrip — clickable incident rows
 *
 * Data is loaded via curatedQueries.runtimeMap().
 */
export function MapView({ zoomTo }: Props) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useQuery(curatedQueries.runtimeMap());

  if (isLoading) {
    return (
      <div className="l0-content">
        <div className="map-empty">
          <span>{t("map.loading")}</span>
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="l0-content">
        <div className="map-empty">
          <span>{t("map.error")}</span>
        </div>
      </div>
    );
  }

  const sourceLabel = data.state.source === "incident_scope"
    ? t("map.sourceIncidentScope", { window: data.state.windowLabel })
    : data.state.source === "no_telemetry"
    ? t("map.sourceNoTelemetry", { window: data.state.windowLabel })
    : t("map.sourceRecent", { window: data.state.windowLabel });

  return (
    <div className="l0-content" data-testid="map-view">
      <StatsBar summary={data.summary} />

      <h2 className="l0-section-title">
        {t("map.runtimeDependencyMap")}{" "}
        <span
          style={{
            fontWeight: 400,
            textTransform: "none",
            letterSpacing: 0,
            fontSize: "var(--fs-xxs)",
            color: "var(--ink-3)",
          }}
        >
          {sourceLabel}
        </span>
      </h2>

      <MapStatusBanner state={data.state} />

      <MapGraph
        services={data.services}
        dependencies={data.dependencies}
        edges={data.edges}
        emptyState={
          <MapEmptyState
            state={data.state}
            activeIncidents={data.summary.activeIncidents}
          />
        }
        zoomTo={zoomTo}
      />

      <h2 className="l0-section-title" style={{ marginTop: 12 }}>
        {t("map.activeIncidents")}
      </h2>
      <IncidentStrip incidents={data.incidents} zoomTo={zoomTo} />
    </div>
  );
}
