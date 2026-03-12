import { Fragment } from "react";
import type { CauseVM } from "../../lib/viewmodels/index.js";

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

interface Props {
  cause: CauseVM;
}

export function CauseCard({ cause }: Props) {
  return (
    <section className="section-cause" data-section="cause">
      <div className="label">Root Cause</div>
      {cause.hypothesis && (
        <div className="cause-hypothesis">{cause.hypothesis}</div>
      )}
      <div className="chain-flow">
        {cause.chain.map((step, i) => (
          <Fragment key={`${step.type}-${i}`}>
            <div className="chain-step" data-type={step.type}>
              <div className="step-tag">{step.type}</div>
              <div className="step-main">{step.title}</div>
              <div className="step-meta">{step.detail}</div>
            </div>
            {i < cause.chain.length - 1 && <Connector />}
          </Fragment>
        ))}
      </div>
    </section>
  );
}
