import type { Incident } from "../../api/types.js";
import type { DiagnosisResult } from "../../api/types.js";
import { MitigationWatch } from "./MitigationWatch.js";
import { ImpactTimeline } from "./ImpactTimeline.js";
import { EvidencePreview } from "./EvidencePreview.js";

interface Props {
  incident: Incident;
  diagnosisResult?: DiagnosisResult;
  onOpenStudio: () => void;
}

export function BottomGrid({ incident, diagnosisResult, onOpenStudio }: Props) {
  return (
    <div className="bottom-grid">
      {diagnosisResult ? (
        <MitigationWatch diagnosisResult={diagnosisResult} />
      ) : (
        <div className="bottom-card">
          <div className="card-title">Mitigation Watch</div>
          <div style={{ fontSize: "12px", color: "var(--ink-3)" }}>
            Pending diagnosis...
          </div>
        </div>
      )}
      <ImpactTimeline incident={incident} />
      <EvidencePreview incident={incident} onOpenStudio={onOpenStudio} />
    </div>
  );
}
