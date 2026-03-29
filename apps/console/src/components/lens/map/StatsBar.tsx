import { useTranslation } from "react-i18next";
import type { RuntimeMapSummary } from "../../../api/curated-types.js";

interface Props {
  summary: RuntimeMapSummary;
}

/**
 * StatsBar — 4 stat blocks showing cluster health at a glance.
 * Displayed at the top of Level 0 (Map view).
 */
export function StatsBar({ summary }: Props) {
  const { t } = useTranslation();

  return (
    <div className="l0-stats" data-testid="stats-bar">
      <div className="stat-block">
        <span
          className={`stat-value${summary.activeIncidents > 0 ? " critical" : ""}`}
          data-testid="stat-active-incidents"
        >
          {summary.activeIncidents}
        </span>
        <span className="stat-label">{t("map.stats.activeIncidents")}</span>
      </div>
      <div className="stat-block">
        <span
          className={`stat-value${summary.degradedServices > 0 ? " warn" : ""}`}
          data-testid="stat-degraded-services"
        >
          {summary.degradedServices}
        </span>
        <span className="stat-label">{t("map.stats.degradedServices")}</span>
      </div>
      <div className="stat-block">
        <span className="stat-value" data-testid="stat-req-per-sec">
          {Math.round(summary.clusterReqPerSec)}
        </span>
        <span className="stat-label">{t("map.stats.reqPerSec")}</span>
      </div>
      <div className="stat-block">
        <span className="stat-value" data-testid="stat-p95">
          {Math.round(summary.clusterP95Ms)}ms
        </span>
        <span className="stat-label">{t("map.stats.p95Latency")}</span>
      </div>
    </div>
  );
}
