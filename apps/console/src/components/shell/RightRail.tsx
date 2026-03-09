import type { DiagnosisResult } from "../../api/types.js";
import { DiagnosisPending } from "../common/DiagnosisPending.js";

interface Props {
  diagnosisResult?: DiagnosisResult;
}

export function RightRail({ diagnosisResult }: Props) {
  return (
    <aside className="right-rail">
      <div className="copilot-header">
        <h3>AI Copilot</h3>
        {diagnosisResult && <span className="grounded">grounded</span>}
      </div>
      <div className="copilot-body">
        {!diagnosisResult ? (
          <DiagnosisPending />
        ) : (
          <>
            <div className="diagnosis-card primary">
              <div className="d-label">Confidence Assessment</div>
              <div className="d-main">{diagnosisResult.confidence.confidence_assessment}</div>
            </div>
            <div className="diagnosis-card">
              <div className="d-label">Uncertainty</div>
              <div className="d-main">{diagnosisResult.confidence.uncertainty}</div>
            </div>
            <div className="diagnosis-card">
              <div className="d-label">Operator Check</div>
              <div className="d-main">
                {diagnosisResult.operator_guidance.operator_checks[0] ?? "\u2014"}
              </div>
            </div>
          </>
        )}
      </div>
      <div className="copilot-footer">
        <div className="ask-label">Ask About</div>
        <div className="ask-chips">
          <button className="ask-chip">Could this still be deploy-related?</button>
          <button className="ask-chip">What tells us the action worked?</button>
          <button className="ask-chip">What competing hypothesis remains?</button>
        </div>
        {/* Chat input — static UI only; interactive chat is Phase E */}
        <div className="chat-input">
          <div className="input-text">Ask about this incident...</div>
          <button className="send-btn">Send</button>
        </div>
      </div>
    </aside>
  );
}
