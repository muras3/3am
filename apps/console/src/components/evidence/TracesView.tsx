import type { Incident } from "../../api/types.js";
import { EmptyView } from "./EmptyView.js";

interface Props {
  incident: Incident;
}

export function TracesView({ incident }: Props) {
  const traces = incident.packet.evidence.representativeTraces;
  if (traces.length === 0) return <EmptyView label="trace" />;

  return (
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
  );
}
