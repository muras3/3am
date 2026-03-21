import { Link } from "@tanstack/react-router";
import type { Incident, RecentActivity, ServiceSurface } from "../../api/types.js";

interface Props {
  services: ServiceSurface[];
  activity: RecentActivity[];
  incidents: Incident[];
}

export function NormalSurface({ services, activity, incidents }: Props) {
  const degradedCount = services.filter((s) => s.health !== "healthy").length;
  const systemState =
    services.length === 0
      ? "Waiting for live traffic"
      : degradedCount === 0
        ? "All systems nominal"
        : `${degradedCount} service${degradedCount > 1 ? "s" : ""} degraded`;

  return (
    <div className="normal-surface">
      <div className="normal-surface-lead">
        <span
          className={`normal-surface-indicator normal-surface-indicator--${degradedCount === 0 ? "ok" : "warn"}`}
          aria-hidden="true"
        />
        <span className="normal-surface-headline">{systemState}</span>
        <span className="normal-surface-count">{services.length} services</span>
      </div>

      {incidents.length > 0 && (
        <div className="incident-entry-banner" data-testid="normal-open-incidents">
          <div className="incident-entry-copy">
            <div className="incident-entry-title">
              {incidents.length} active incident{incidents.length > 1 ? "s" : ""}
            </div>
            <div className="incident-entry-text">
              Enter the reliability workspace to act on the current issue.
            </div>
          </div>
          <div className="incident-entry-links">
            {incidents.slice(0, 3).map((incident) => (
              <Link
                key={incident.incidentId}
                className="incident-entry-link"
                to="/"
                search={{ incidentId: incident.incidentId, level: 0 as const, tab: "traces" as const }}
              >
                {incident.packet.scope.primaryService}
              </Link>
            ))}
          </div>
        </div>
      )}

      {services.length === 0 ? (
        <div className="normal-empty-card">
          <div className="normal-empty-title">Ambient surface is empty</div>
          <div className="normal-empty-text">
            Recent service health and activity will appear after telemetry arrives.
          </div>
        </div>
      ) : (
        <ul className="normal-surface-grid">
          {services.map((svc) => (
            <ServiceCard key={svc.name} service={svc} />
          ))}
        </ul>
      )}

      <div className="normal-activity">
        <div className="normal-activity-header">
          <div className="normal-activity-title">Recent Activity</div>
          <div className="normal-activity-meta">latest first</div>
        </div>
        {activity.length === 0 ? (
          <div className="normal-empty-card normal-empty-card--compact">
            <div className="normal-empty-text">
              No recent spans buffered yet. Once traffic flows, traces will appear here.
            </div>
          </div>
        ) : (
          <div className="activity-stream">
            {activity.map((entry) => (
              <div key={`${entry.traceId}-${entry.ts}`} className="activity-row">
                <span className="act-time">
                  {new Date(entry.ts).toISOString().slice(11, 19)}
                </span>
                <span className="act-svc">{entry.service}</span>
                <span
                  className={`act-code ${entry.anomalous ? "act-code-bad" : "act-code-ok"}`}
                >
                  {entry.httpStatus ?? "\u2014"}
                </span>
                <span className="act-route">{entry.route || "non-http span"}</span>
                <span className="act-dur">{Math.round(entry.durationMs)}ms</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ServiceCard({ service }: { service: ServiceSurface }) {
  return (
    <li className={`service-card service-card--${service.health}`}>
      <span className={`service-dot service-dot--${service.health}`} aria-hidden="true" />
      <span className="service-name">{service.name}</span>
      <span className="service-status">{service.health}</span>
      <span className="service-metrics">
        {Math.round(service.reqPerSec)}/s · p95 {Math.round(service.p95Ms)}ms
      </span>
    </li>
  );
}
