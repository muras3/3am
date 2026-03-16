import type { EvidenceEntryVM } from "../../lib/viewmodels/index.js";

interface Props {
  evidence: EvidenceEntryVM;
  onOpenStudio: () => void;
}

export function EvidenceEntry({ evidence, onOpenStudio }: Props) {
  const tracesText =
    evidence.traceCount > 0
      ? `${evidence.traceCount} traces, ${evidence.traces} spans`
      : `${evidence.traces} spans captured`;

  return (
    <div className="bottom-card" data-section="evidence">
      <div className="card-title">Evidence Preview</div>
      <div className="evidence-preview-row">
        <div className="ep-label">Traces</div>
        <div className="ep-value">{tracesText}</div>
      </div>
      <div className="evidence-preview-row">
        <div className="ep-label">Metrics</div>
        <div className="ep-value">
          {evidence.metrics > 0 ? `${evidence.metrics} changed` : "none"}
        </div>
      </div>
      <div className="evidence-preview-row">
        <div className="ep-label">Logs</div>
        <div className="ep-value">
          {evidence.logs > 0 ? `${evidence.logs} entries` : "none"}
        </div>
      </div>
      <div className="evidence-preview-row">
        <div className="ep-label">Platform</div>
        <div className="ep-value">
          {evidence.platformEvents > 0
            ? `${evidence.platformEvents} events`
            : "none"}
        </div>
      </div>
      <button
        className="btn-evidence"
        onClick={onOpenStudio}
        data-testid="open-evidence-studio"
      >
        <span className="dot" />
        Open Evidence Studio
      </button>
    </div>
  );
}
