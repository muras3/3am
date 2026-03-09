import type { Incident } from "../../api/types.js";
import { EmptyView } from "./EmptyView.js";

interface Props {
  incident: Incident;
}

function barColor(spanStatusCode: number, httpStatusCode?: number): string {
  if (spanStatusCode === 2) return "var(--accent)";
  if (httpStatusCode === 429) return "var(--amber)";
  return "var(--teal)";
}

export function TracesView({ incident }: Props) {
  const traces = incident.packet.evidence.representativeTraces;
  if (traces.length === 0) return <EmptyView label="trace" />;

  const maxDurationMs = Math.max(...traces.map((t) => t.durationMs));

  return (
    <>
      <div className="waterfall">
        {traces.map((t) => (
          <div key={t.spanId} className="wf-row">
            <span
              style={{
                display: "inline-block",
                width: "12px",
                height: "12px",
                borderRadius: "50%",
                background: barColor(t.spanStatusCode, t.httpStatusCode),
                flexShrink: 0,
              }}
            />
            <span>{t.serviceName}</span>
            <div
              className="wf-bar"
              style={{
                width: `${(t.durationMs / maxDurationMs) * 100}%`,
                background: barColor(t.spanStatusCode, t.httpStatusCode),
              }}
            />
            <span>{t.durationMs}ms</span>
          </div>
        ))}
      </div>
      <div className="trace-attrs">
        <div className="trace-attrs-head">
          <span>Span ID</span>
          <span>Service</span>
          <span>Details</span>
        </div>
        {traces.map((t) => (
          <div key={t.spanId} className="trace-attrs-row">
            <div className="ta-span">{t.spanId.slice(0, 12)}...</div>
            <div className="ta-svc">{t.serviceName}</div>
            <div className="ta-attrs">
              {t.durationMs}ms
              {t.httpStatusCode != null ? ` · HTTP ${t.httpStatusCode}` : ""}
              {` · status ${t.spanStatusCode}`}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
