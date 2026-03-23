import { useQuery } from "@tanstack/react-query";
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
 * 2. Section title + MapGraph — SVG dependency map with nodes/edges
 * 3. Section title + IncidentStrip — clickable incident rows
 *
 * Data is loaded via curatedQueries.runtimeMap().
 */
export function MapView({ zoomTo }: Props) {
  const { data, isLoading, isError } = useQuery(curatedQueries.runtimeMap());

  if (isLoading) {
    return (
      <div className="l0-content">
        <div className="map-empty">
          <span>Loading map…</span>
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="l0-content">
        <div className="map-empty">
          <span>Unable to load runtime map.</span>
        </div>
      </div>
    );
  }

  const sourceLabel = data.state.source === "incident_scope"
    ? `— observed from preserved incident spans (${data.state.windowLabel})`
    : data.state.source === "no_telemetry"
    ? `— waiting for observed spans (${data.state.windowLabel})`
    : `— observed from recent spans (${data.state.windowLabel})`;

  return (
    <div className="l0-content" data-testid="map-view">
      <StatsBar summary={data.summary} />

      <h2 className="l0-section-title">
        Runtime Dependency Map{" "}
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
        nodes={data.nodes}
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
        Active Incidents
      </h2>
      <IncidentStrip incidents={data.incidents} zoomTo={zoomTo} />
    </div>
  );
}
