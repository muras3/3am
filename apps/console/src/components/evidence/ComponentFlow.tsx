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
      {flow.edges.length > 0 && (
        <div className="flow-edges">
          {flow.edges.map((edge, i) => (
            <div key={i} className="flow-edge">
              <span className="flow-edge-from">{edge.from}</span>
              <span className="flow-edge-arrow">→</span>
              <span className="flow-edge-to">{edge.to}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
