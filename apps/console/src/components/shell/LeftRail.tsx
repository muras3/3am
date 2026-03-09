import { Link } from "@tanstack/react-router";
import type { Incident } from "../../api/types.js";

interface Props {
  incidents: Incident[];
  currentIncidentId?: string;
}

export function LeftRail({ incidents, currentIncidentId }: Props) {
  if (incidents.length === 0) {
    return (
      <aside className="left-rail">
        <div className="rail-header">Open Incidents</div>
        <div style={{ padding: "16px 14px", fontSize: "12px", color: "var(--ink-3)" }}>
          No incidents.
        </div>
      </aside>
    );
  }

  return (
    <aside className="left-rail">
      <div className="rail-header">Open Incidents</div>
      {incidents.map((inc) => (
        <Link
          key={inc.incidentId}
          to="/incidents/$incidentId"
          params={{ incidentId: inc.incidentId }}
          style={{ textDecoration: "none", color: "inherit" }}
        >
          <div className={`incident-item${inc.incidentId === currentIncidentId ? " active" : ""}`}>
            <div className="name">
              {inc.packet.scope.primaryService}
              <span className="sev sev-critical">open</span>
            </div>
            <div className="meta">
              {inc.packet.scope.affectedRoutes.slice(0, 2).join(" / ")}
            </div>
          </div>
        </Link>
      ))}
      <div className="rail-meta" style={{ marginTop: "auto" }}>
        <div className="rail-meta-row">
          <span>Open now</span>
          <strong>{incidents.length} incidents</strong>
        </div>
      </div>
    </aside>
  );
}
