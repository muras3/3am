import type { Incident } from "../../api/types.js";

const severityConfig: Record<string, { label: string; color: string; bg: string; dot: string }> = {
  critical: { label: "Critical", color: "var(--accent-text)", bg: "var(--accent-soft)", dot: "var(--accent)" },
  high:     { label: "High",     color: "var(--accent-text)", bg: "var(--accent-soft)", dot: "var(--accent)" },
  medium:   { label: "Medium",   color: "var(--amber)",       bg: "var(--amber-soft)",  dot: "var(--amber)" },
  low:      { label: "Low",      color: "var(--teal)",        bg: "var(--teal-soft)",    dot: "var(--teal)" },
};

interface Props {
  incident?: Incident;
}

export function TopBar({ incident }: Props) {
  const sev = incident?.packet.signalSeverity;
  const cfg = sev ? severityConfig[sev] : undefined;

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
      {incident && (
        <div
          className="severity-badge"
          data-severity={sev ?? "unknown"}
          style={cfg ? { color: cfg.color, background: cfg.bg } : undefined}
        >
          {cfg?.label ?? "Unknown"}
        </div>
      )}
      <div className="topbar-time" style={{ marginLeft: "auto" }}>
        {incident ? new Date(incident.openedAt).toUTCString().slice(17, 25) + " UTC" : ""}
      </div>
      {incident && (
        <div className="topbar-status">{incident.status === "open" ? "Active" : "Closed"}</div>
      )}
    </header>
  );
}
