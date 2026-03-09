import type { Incident } from "../../api/types.js";
import { EmptyView } from "./EmptyView.js";

interface Props {
  incident: Incident;
}

function formatTime(isoString: string): string {
  // Extract HH:MM:SS from ISO 8601 string (e.g. "2026-03-09T03:00:12Z")
  const match = isoString.match(/T(\d{2}:\d{2}:\d{2})/);
  return match ? match[1] : isoString;
}

function classifyLevel(signal: string): { label: string; className: string } {
  const lower = signal.toLowerCase();
  if (lower.includes("429") || lower.includes("error")) {
    return { label: "ERROR", className: "level-error" };
  }
  return { label: "WARN", className: "level-warn" };
}

export function LogsView({ incident }: Props) {
  const signals = incident.packet.triggerSignals;

  if (signals.length === 0) {
    return <EmptyView label="trigger signal" />;
  }

  return (
    <div className="logs-table">
      {signals.map((s, i) => {
        const { label, className } = classifyLevel(s.signal);
        return (
          <div key={i} className="log-row">
            <span className="lr-time">{formatTime(s.firstSeenAt)}</span>
            <span className={`lr-level ${className}`}>{label}</span>
            <span className="lr-svc">{s.entity}</span>
            <span className="lr-msg">{s.signal}</span>
          </div>
        );
      })}
    </div>
  );
}
