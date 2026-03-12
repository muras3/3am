import type { Incident } from "../../api/types.js";

interface Props {
  incident?: Incident;
}

export function TopBar({ incident }: Props) {
  return (
    <header className="topbar">
      <div className="topbar-logo">
        <span className="pulse" />
        3amoncall
      </div>
      <div className="topbar-sep" />
      <span className="status-dot" />
      <div className="topbar-incident-context">
        {incident && (
          <div className="topbar-incident">
            <span className="id">{incident.incidentId}</span>
            {incident.packet.scope.primaryService}
          </div>
        )}
      </div>
      {incident && <div className="severity-badge">Critical</div>}
      <div className="topbar-time" style={{ marginLeft: "auto" }}>
        {incident ? new Date(incident.openedAt).toUTCString().slice(17, 25) + " UTC" : ""}
      </div>
      {incident && (
        <div className="topbar-status">{incident.status === "open" ? "Active" : "Closed"}</div>
      )}
    </header>
  );
}
