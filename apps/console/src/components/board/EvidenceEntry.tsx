import type { EvidenceEntryVM } from "../../lib/viewmodels/index.js";

interface Props {
  evidence: EvidenceEntryVM;
  onOpenStudio: () => void;
}

export function EvidenceEntry({ evidence, onOpenStudio }: Props) {
  return (
    <section className="section-evidence" data-section="evidence">
      <div className="card-title">Evidence</div>
      <div className="evidence-preview-row">
        <div className="ep-label">Traces</div>
        <div className="ep-value">{evidence.traces} spans captured</div>
      </div>
      <div className="evidence-preview-row">
        <div className="ep-label">Metrics</div>
        <div className="ep-value">
          {evidence.metrics > 0 ? `${evidence.metrics} metrics` : "none"}
        </div>
      </div>
      <div className="evidence-preview-row">
        <div className="ep-label">Logs</div>
        <div className="ep-value">
          {evidence.logs > 0 ? `${evidence.logs} entries` : "none"}
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
    </section>
  );
}
