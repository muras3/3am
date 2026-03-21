import { useQuery } from "@tanstack/react-query";
import { curatedQueries } from "../../../api/queries.js";
import type { LensLevel } from "../../../routes/__root.js";
import { StatsBar } from "./StatsBar.js";
import { MapGraph } from "./MapGraph.js";
import { IncidentStrip } from "./IncidentStrip.js";

interface Props {
  zoomTo: (level: LensLevel, trigger?: HTMLElement) => void;
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
          — observed from recent spans (last 30m)
        </span>
      </h2>

      {data.nodes.length === 0 ? (
        <div className="map-empty">
          <span>No traffic observed yet.</span>
        </div>
      ) : (
        <MapGraph nodes={data.nodes} edges={data.edges} zoomTo={zoomTo} />
      )}

      {data.incidents.length > 0 && (
        <>
          <h2 className="l0-section-title" style={{ marginTop: 12 }}>
            Active Incidents
          </h2>
          <IncidentStrip incidents={data.incidents} zoomTo={zoomTo} />
        </>
      )}
    </div>
  );
}
