import type { Incident } from "../../api/types.js";
import { EmptyView } from "./EmptyView.js";

interface Props {
  incident: Incident;
}

interface LogEntry {
  timestamp?: string;
  severity?: string;
  service?: string;
  body?: string;
}

function formatTime(isoString: string): string {
  // Extract HH:MM:SS from ISO 8601 string (e.g. "2026-03-09T03:00:12Z")
  const match = isoString.match(/T(\d{2}:\d{2}:\d{2})/);
  return match ? match[1] : isoString;
}

function severityClass(sev: string): string {
  const s = sev.toUpperCase();
  if (s === "FATAL" || s === "ERROR") return "level-error";
  return "level-warn";
}

const LOGS_LIMIT = 50;

export function LogsView({ incident }: Props) {
  const logs = (incident.packet.evidence.relevantLogs ?? []) as LogEntry[];

  if (logs.length === 0) {
    return <EmptyView label="log record" />;
  }

  const visible = logs.slice(0, LOGS_LIMIT);
  const overflow = logs.length - LOGS_LIMIT;

  return (
    <div className="logs-table">
      {visible.map((log, i) => {
        const sev = (log.severity ?? "WARN").toUpperCase();
        return (
          <div key={i} className="log-row">
            <span className="lr-time">{log.timestamp ? formatTime(log.timestamp) : "—"}</span>
            <span className={`lr-level ${severityClass(sev)}`}>{sev}</span>
            <span className="lr-svc">{log.service ?? ""}</span>
            <span className="lr-msg">{log.body ?? ""}</span>
          </div>
        );
      })}
      {overflow > 0 && (
        <div className="timeline-overflow">+{overflow} more entries</div>
      )}
    </div>
  );
}
