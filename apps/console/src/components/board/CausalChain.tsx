import { Fragment } from "react";
import type { CausalChainStep } from "../../api/types.js";

interface Props {
  steps: CausalChainStep[];
}

function Connector() {
  return (
    <div className="chain-connector">
      <svg width="28" height="12" viewBox="0 0 28 12">
        <line x1="0" y1="6" x2="22" y2="6" />
        <polygon points="20,2 28,6 20,10" />
      </svg>
    </div>
  );
}

export function CausalChain({ steps }: Props) {
  return (
    <section className="section-chain">
      <div className="label">Why This Action</div>
      <div className="chain-flow">
        {steps.map((step, i) => (
          <Fragment key={`${step.type}-${i}`}>
            <div className="chain-step" data-type={step.type}>
              <div className="step-tag">{step.type}</div>
              <div className="step-main">{step.title}</div>
              <div className="step-meta">{step.detail}</div>
            </div>
            {i < steps.length - 1 && <Connector />}
          </Fragment>
        ))}
      </div>
    </section>
  );
}
