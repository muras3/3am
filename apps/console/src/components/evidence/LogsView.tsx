import { useState } from "react";
import type { RelevantLog } from "../../api/types.js";
import { EmptyView } from "./EmptyView.js";

interface Props {
  rawLogs: RelevantLog[];
  packetLogs: RelevantLog[];
}

const LOGS_LIMIT = 100;

function formatTime(iso: string): string {
  const match = iso.match(/T(\d{2}:\d{2}:\d{2})/);
  return match ? match[1] : iso;
}

function severityClass(sev: string): string {
  const s = sev.toUpperCase();
  if (s === "FATAL" || s === "ERROR") return "level-error";
  return "level-warn";
}

function isHighlighted(log: RelevantLog, packetLogs: RelevantLog[]): boolean {
  return packetLogs.some(
    (p) =>
      p.timestamp === log.timestamp &&
      p.service === log.service &&
      p.body === log.body,
  );
}

export function LogsView({ rawLogs, packetLogs }: Props) {
  const [severityFilter, setSeverityFilter] = useState<string | null>(null);
  const [serviceFilter, setServiceFilter] = useState<string | null>(null);
  const [expandedIdx, setExpandedIdx] = useState<Set<number>>(new Set());

  if (rawLogs.length === 0) {
    return <EmptyView label="log record" />;
  }

  const services = Array.from(new Set(rawLogs.map((l) => l.service)));
  const severities = Array.from(
    new Set(rawLogs.map((l) => l.severity.toUpperCase())),
  );

  const filtered = rawLogs
    .filter((l) => !severityFilter || l.severity.toUpperCase() === severityFilter)
    .filter((l) => !serviceFilter || l.service === serviceFilter)
    .slice(0, LOGS_LIMIT);

  const toggleExpand = (idx: number) => {
    setExpandedIdx((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  return (
    <div data-testid="logs-view">
      <div className="logs-filters">
        <div className="filter-group">
          {severities.map((sev) => (
            <button
              key={sev}
              className={`filter-btn${severityFilter === sev ? " active" : ""}`}
              data-testid="severity-filter"
              onClick={() => setSeverityFilter(severityFilter === sev ? null : sev)}
            >
              {sev}
            </button>
          ))}
        </div>
        <div className="filter-chips">
          {services.map((svc) => (
            <button
              key={svc}
              className={`filter-chip${serviceFilter === svc ? " active" : ""}`}
              data-testid="service-chip"
              onClick={() => setServiceFilter(serviceFilter === svc ? null : svc)}
            >
              {svc}
            </button>
          ))}
        </div>
      </div>

      <div className="logs-table">
        <div className="logs-head">
          <span>Time</span>
          <span>Level</span>
          <span>Service</span>
          <span>Message</span>
        </div>
        {filtered.map((log, i) => {
          const sev = log.severity.toUpperCase();
          const expanded = expandedIdx.has(i);
          const highlighted = isHighlighted(log, packetLogs);
          const hasAttrs = Object.keys(log.attributes).length > 0;

          return (
            <div
              key={i}
              className={`log-row${highlighted ? " highlighted" : ""}${hasAttrs ? " expandable" : ""}`}
              data-testid="log-row"
              onClick={() => hasAttrs && toggleExpand(i)}
            >
              <span className="lr-time">{formatTime(log.timestamp)}</span>
              <span className={`lr-level ${severityClass(sev)}`}>{sev}</span>
              <span className="lr-svc">{log.service}</span>
              <span className="lr-msg">{log.body}</span>
              {expanded && hasAttrs && (
                <div className="log-attrs open" data-testid="log-attrs">
                  {Object.entries(log.attributes).map(([k, v]) => (
                    <div key={k} className="la-row">
                      <span className="la-key">{k}</span>
                      <span className="la-val">{String(v)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {rawLogs.length > LOGS_LIMIT && (
          <div className="timeline-overflow">
            +{rawLogs.length - LOGS_LIMIT} more entries
          </div>
        )}
      </div>
    </div>
  );
}
