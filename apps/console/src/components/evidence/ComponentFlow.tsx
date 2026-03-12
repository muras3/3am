import type { ComponentFlowVM } from "../../lib/viewmodels/index.js";

const ROLE_CLASS: Record<string, string> = {
  cause: "flow-node-cause",
  spread: "flow-node-spread",
  impact: "flow-node-impact",
};

interface Props {
  flow: ComponentFlowVM;
}

export function ComponentFlow({ flow }: Props) {
  if (flow.nodes.length === 0) return null;

  return (
    <div className="component-flow">
      <div className="flow-nodes">
        {flow.nodes.map((node) => (
          <div
            key={node.id}
            className={`flow-node ${ROLE_CLASS[node.role] ?? ""}`}
            data-role={node.role}
          >
            {node.label}
          </div>
        ))}
      </div>
    </div>
  );
}
