import { Fragment } from "react";
import type { CausalStep, CausalStepType } from "../../../api/curated-types.js";

interface Props {
  steps: CausalStep[];
}

function stepBorderClass(type: CausalStepType): string {
  switch (type) {
    case "external": return "lens-board-chain-step-external";
    case "system":   return "lens-board-chain-step-system";
    case "incident": return "lens-board-chain-step-incident";
    case "impact":   return "lens-board-chain-step-impact";
  }
}

function ChainArrow() {
  return (
    <div className="lens-board-chain-arrow" aria-hidden="true">
      <svg width="28" height="20" viewBox="0 0 28 20">
        <line x1="0" y1="10" x2="20" y2="10" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2" />
        <polygon points="20,6 28,10 20,14" fill="currentColor" />
      </svg>
    </div>
  );
}

export function CauseCard({ steps }: Props) {
  return (
    <div className="lens-board-chain-section">
      <h2 className="lens-board-section-label">Causal Chain</h2>
      <div className="lens-board-chain-flow" role="list">
        {steps.map((step, i) => (
          <Fragment key={`${step.type}-${i}`}>
            <div
              className={`lens-board-chain-step ${stepBorderClass(step.type)}`}
              role="listitem"
              tabIndex={0}
              aria-label={`${step.tag}: ${step.title}. ${step.detail}`}
            >
              <div className="lens-board-step-tag">{step.tag}</div>
              <div className="lens-board-step-title">{step.title}</div>
              <div className="lens-board-step-detail">{step.detail}</div>
            </div>
            {i < steps.length - 1 && <ChainArrow />}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
