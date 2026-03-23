import type { RuntimeMapState } from "../../../api/curated-types.js";

interface Props {
  state: RuntimeMapState;
  activeIncidents: number;
}

export function MapStatusBanner({ state }: Pick<Props, "state">) {
  if (state.source !== "incident_scope") return null;

  return (
    <div className="map-status-banner" data-testid="map-status-banner">
      <span className="map-status-kicker">Live window empty</span>
      <strong>Showing observed spans captured with {state.windowLabel}.</strong>
      <span>This is incident-scoped fallback, not an inferred topology.</span>
    </div>
  );
}

export function MapEmptyState({ state, activeIncidents }: Props) {
  const hasIncidents = activeIncidents > 0;
  const title = hasIncidents
    ? "No recent spans in the live window."
    : "No spans observed yet in this environment.";
  const detail = hasIncidents
    ? "Open incidents still exist below. Use one to inspect preserved incident evidence while the runtime map waits for fresh traffic."
    : "The map only draws observed call paths from spans. Once traffic arrives, entry points, runtime units, and dependencies will appear here.";
  const reason = state.emptyReason === "no_preserved_incident_spans"
    ? "No preserved incident spans were available to reconstruct a scoped map."
    : hasIncidents
    ? "No incident-scoped fallback was available."
    : "No open incidents were returned.";

  return (
    <div className="map-empty-shell" data-testid="map-empty-state">
      <div className="map-empty-copy">
        <span className="map-empty-kicker">Observed from spans</span>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
      <div className="map-empty-meta" aria-label="Map empty state details">
        <span>{state.windowLabel} has no live topology</span>
        <span>{activeIncidents} open incidents</span>
        <span>{reason}</span>
      </div>
    </div>
  );
}
