import type { Incident } from "../../api/types.js";

interface Props {
  incident: Incident;
  onOpenStudio: () => void;
}

export function EvidencePreview({ incident, onOpenStudio }: Props) {
  const { evidence } = incident.packet;
  return (
    <div className="bottom-card">
      <div className="card-title">Evidence Preview</div>
      <div className="evidence-preview-row">
        <div className="ep-label">Traces</div>
        <div className="ep-value">
          {evidence.representativeTraces.length} spans captured
        </div>
      </div>
      <div className="evidence-preview-row">
        <div className="ep-label">Metrics</div>
        <div className="ep-value">
          {evidence.changedMetrics.length > 0
            ? `${evidence.changedMetrics.length} metrics`
            : "none"}
        </div>
      </div>
      <div className="evidence-preview-row">
        <div className="ep-label">Logs</div>
        <div className="ep-value">
          {evidence.relevantLogs.length > 0
            ? `${evidence.relevantLogs.length} entries`
            : "none"}
        </div>
      </div>
      <button className="btn-evidence" onClick={onOpenStudio}>
        <span className="dot" />
        Open Evidence Studio
      </button>
    </div>
  );
}
