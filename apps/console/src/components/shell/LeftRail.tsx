import { Link } from "@tanstack/react-router";
import type { Incident, ServiceSurface } from "../../api/types.js";

interface Props {
  incidents: Incident[];
  currentIncidentId?: string;
  services: ServiceSurface[];
}

function healthLabel(health: ServiceSurface["health"]): string {
  if (health === "critical") return "critical";
  if (health === "degraded") return "degraded";
  return "healthy";
}

export function LeftRail({ incidents, currentIncidentId, services }: Props) {
  const normalInactive = Boolean(currentIncidentId);
  const incidentInactive = !normalInactive;

  return (
    <aside className="left-rail">
      <div
        className="left-rail-normal"
        aria-hidden={normalInactive}
        inert={normalInactive}
      >
        <div className="rail-header">Services</div>
        {services.length === 0 ? (
          <div className="rail-empty">Ambient service data will appear as traffic flows.</div>
        ) : (
          services.map((svc) => (
            <div key={svc.name} className="service-rail-item">
              <span className={`service-dot service-dot--${svc.health}`} aria-hidden="true" />
              <span className="service-rail-name">{svc.name}</span>
              <span className="service-rail-meta">
                {Math.round(svc.reqPerSec)}/s · {Math.round(svc.p95Ms)}ms
              </span>
            </div>
          ))
        )}

        <div className="rail-divider" />
        <div className="rail-header">Open Incidents</div>
        {incidents.length === 0 ? (
          <div className="rail-empty">No active incidents.</div>
        ) : (
          incidents.map((inc) => (
            <Link
              key={inc.incidentId}
              to="/"
              search={{ incidentId: inc.incidentId }}
              style={{ textDecoration: "none", color: "inherit" }}
            >
              <div className="rail-incident-entry">
                <span className={`service-dot service-dot--${healthLabel(inc.packet.severity === "critical" ? "critical" : "degraded")}`} aria-hidden="true" />
                <span className="rail-incident-name">{inc.packet.scope.primaryService}</span>
                <span className="rail-incident-open">Open</span>
              </div>
            </Link>
          ))
        )}
      </div>

      <div
        className="left-rail-incidents"
        aria-hidden={incidentInactive}
        inert={incidentInactive}
      >
        <div className="rail-header">Open Incidents</div>
        {incidents.length === 0 ? (
          <div className="rail-empty">No incidents.</div>
        ) : (
          incidents.map((inc) => (
            <Link
              key={inc.incidentId}
              to="/"
              search={{ incidentId: inc.incidentId }}
              style={{ textDecoration: "none", color: "inherit" }}
            >
              <div className={`incident-item${inc.incidentId === currentIncidentId ? " active" : ""}`}>
                <div className="name">
                  {inc.packet.scope.primaryService}
                  <span className={`sev sev-${inc.packet.severity ?? "critical"}`}>
                    {inc.status}
                  </span>
                </div>
                <div className="meta">
                  {inc.packet.scope.affectedRoutes.slice(0, 2).join(" / ")}
                </div>
              </div>
            </Link>
          ))
        )}
        {incidents.length > 0 && (
          <div className="rail-meta" style={{ marginTop: "auto" }}>
            <div className="rail-meta-row">
              <span>Open now</span>
              <strong>{incidents.length} incidents</strong>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
