import type { ActionVM } from "../../lib/viewmodels/index.js";

interface Props {
  action: ActionVM;
}

export function ImmediateAction({ action }: Props) {
  return (
    <section className="section-action" data-section="action">
      <div className="eyebrow">Immediate Action</div>
      <div className="action-text">{action.primaryText}</div>
      <div
        style={{
          marginTop: "8px",
          fontSize: "var(--fs-xs)",
          color: "var(--accent-text)",
        }}
      >
        <strong>Do not:</strong> {action.doNot}
      </div>
    </section>
  );
}
