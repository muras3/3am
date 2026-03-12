import type { ActionVM } from "../../lib/viewmodels/index.js";

interface Props {
  action: ActionVM;
}

export function ImmediateAction({ action }: Props) {
  return (
    <section className="section-action" data-section="action">
      <div className="eyebrow">Immediate Action</div>
      <div className="action-text">{action.primaryText}</div>
      <div className="action-why">
        <strong>Why:</strong> {action.rationale}
      </div>
      <div className="action-do-not">
        <strong>Do not:</strong> {action.doNot}
      </div>
    </section>
  );
}
