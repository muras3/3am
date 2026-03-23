import type { RuntimeMapSummary } from "../../../api/curated-types.js";

interface Props {
  summary: RuntimeMapSummary;
}

/**
 * StatsBar — 4 stat blocks showing cluster health at a glance.
 * Displayed at the top of Level 0 (Map view).
 */
export function StatsBar({ summary }: Props) {
  return (
    <div className="l0-stats" data-testid="stats-bar">
      <div className="stat-block">
        <span
          className={`stat-value${summary.activeIncidents > 0 ? " critical" : ""}`}
          data-testid="stat-active-incidents"
        >
          {summary.activeIncidents}
        </span>
        <span className="stat-label">Active Incidents</span>
      </div>
      <div className="stat-block">
        <span
          className={`stat-value${summary.degradedNodes > 0 ? " warn" : ""}`}
          data-testid="stat-degraded-nodes"
        >
          {summary.degradedNodes}
        </span>
        <span className="stat-label">Degraded Services</span>
      </div>
      <div className="stat-block">
        <span className="stat-value" data-testid="stat-req-per-sec">
          {Math.round(summary.clusterReqPerSec)}
        </span>
        <span className="stat-label">Req/s (cluster)</span>
      </div>
      <div className="stat-block">
        <span className="stat-value" data-testid="stat-p95">
          {Math.round(summary.clusterP95Ms)}ms
        </span>
        <span className="stat-label">P95 Latency</span>
      </div>
    </div>
  );
}
