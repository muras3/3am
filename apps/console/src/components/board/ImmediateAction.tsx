import type { DiagnosisResult } from "../../api/types.js";

interface Props {
  diagnosisResult: DiagnosisResult;
}

export function ImmediateAction({ diagnosisResult }: Props) {
  const { recommendation } = diagnosisResult;
  return (
    <section className="section-action">
      <div className="eyebrow">Immediate Action</div>
      <div className="action-text">{recommendation.immediate_action}</div>
      <div className="action-why">
        <strong>Why:</strong> {recommendation.action_rationale_short}
      </div>
      <div
        style={{
          marginTop: "8px",
          fontSize: "var(--fs-xs)",
          color: "var(--accent-text)",
        }}
      >
        <strong>Do not:</strong> {recommendation.do_not}
      </div>
    </section>
  );
}
