import type { Incident } from "../../api/types.js";

interface Props {
  incident: Incident;
}

interface MetricEntry {
  name?: string;
  service?: string;
  summary?: unknown;
}

function formatSummary(summary: unknown): string {
  if (!summary || typeof summary !== "object") return "";
  const s = summary as Record<string, unknown>;
  const parts: string[] = [];
  if (s.count !== undefined) parts.push(`count: ${s.count}`);
  if (s.sum !== undefined) parts.push(`sum: ${Number(s.sum).toFixed(2)}`);
  if (s.min !== undefined) parts.push(`min: ${s.min}`);
  if (s.max !== undefined) parts.push(`max: ${s.max}`);
  if (s.asDouble !== undefined) parts.push(String(Number(s.asDouble).toFixed(4)));
  if (s.asInt !== undefined) parts.push(String(s.asInt));
  return parts.join(" · ") || JSON.stringify(summary);
}

const METRICS_LIMIT = 100;

export function MetricsView({ incident }: Props) {
  const metrics = (incident.packet.evidence.changedMetrics ?? []) as MetricEntry[];

  if (metrics.length === 0) {
    return (
      <div className="ev-empty-metrics" style={{ padding: "24px 20px" }}>
        <div
          style={{
            width: "100%",
            height: "120px",
            border: "1.5px dashed var(--line-strong)",
            borderRadius: "var(--radius)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--ink-3)",
            fontSize: "12px",
            marginBottom: "12px",
            background: "var(--panel-2)",
          }}
        >
          <svg
            width="48"
            height="32"
            viewBox="0 0 48 32"
            fill="none"
            style={{ opacity: 0.35 }}
          >
            <polyline
              points="0,28 8,20 16,24 24,10 32,16 40,6 48,12"
              stroke="currentColor"
              strokeWidth="2"
              fill="none"
            />
          </svg>
        </div>
        <div
          style={{
            fontSize: "12px",
            color: "var(--ink-3)",
            textAlign: "center",
          }}
        >
          No metrics data — will appear when /v1/metrics ingest is active
        </div>
      </div>
    );
  }

  return (
    <div className="metrics-table">
      {metrics.slice(0, METRICS_LIMIT).map((m, i) => (
        <div key={i} className="metric-row">
          <div className="metric-name">{m.name ?? "—"}</div>
          <div className="metric-svc">{m.service ?? ""}</div>
          <div className="metric-val">{formatSummary(m.summary)}</div>
        </div>
      ))}
      {metrics.length > METRICS_LIMIT && (
        <div className="timeline-overflow">+{metrics.length - METRICS_LIMIT} more entries</div>
      )}
    </div>
  );
}
