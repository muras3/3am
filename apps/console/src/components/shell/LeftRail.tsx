import { Link } from "@tanstack/react-router";
import type { Incident } from "../../api/types.js";

const STATIC_SERVICES = [
  { name: "api-gateway", status: "healthy" },
  { name: "auth-service", status: "healthy" },
  { name: "stripe-proxy", status: "degraded" },
];

interface Props {
  incidents: Incident[];
  currentIncidentId?: string;
}

export function LeftRail({ incidents, currentIncidentId }: Props) {
  return (
    <aside className="left-rail">
      {/* Normal mode: service health overview */}
      <div className="left-rail-normal">
        <div className="rail-header">Services</div>
        {STATIC_SERVICES.map((svc) => (
          <div key={svc.name} className="service-rail-item">
            <span className={`service-dot service-dot--${svc.status}`} />
            <span className="service-rail-name">{svc.name}</span>
          </div>
        ))}
      </div>

      {/* Incident mode: open incident list */}
      <div className="left-rail-incidents">
        <div className="rail-header">Open Incidents</div>
        {incidents.length === 0 ? (
          <div style={{ padding: "16px 14px", fontSize: "12px", color: "var(--ink-3)" }}>
            No incidents.
          </div>
        ) : (
          incidents.map((inc) => (
            <Link
              key={inc.incidentId}
              to="/"
              search={{ incidentId: inc.incidentId }}
              style={{ textDecoration: "none", color: "inherit" }}
            >
              <div
                className={`incident-item${inc.incidentId === currentIncidentId ? " active" : ""}`}
              >
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
