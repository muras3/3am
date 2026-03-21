import type { MapNode as MapNodeType } from "../../../api/curated-types.js";
import type { LensLevel } from "../../../routes/__root.js";

interface Props {
  node: MapNodeType;
  style: React.CSSProperties;
  zoomTo: (level: LensLevel, trigger?: HTMLElement) => void;
}

/**
 * MapNode — individual node card rendered on the dependency map.
 *
 * 3 visual styles:
 * - entry_point: square, left border accent
 * - runtime_unit: rounded pill
 * - dependency: dashed border, panel-2 background
 */
export function MapNode({ node, style, zoomTo }: Props) {
  const tierClass = tierToClass(node.tier);
  const statusClass = node.status !== "healthy" ? ` n-${node.status}` : "";
  const isClickable = !!node.incidentId;

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (isClickable) {
      zoomTo(1, e.currentTarget);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (isClickable && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      zoomTo(1, e.currentTarget as HTMLElement);
    }
  }

  return (
    <div
      className={`map-node ${tierClass}${statusClass}${isClickable ? " clickable" : ""}`}
      style={style}
      tabIndex={0}
      role="button"
      aria-label={`${node.label}${node.status !== "healthy" ? ` — ${node.status}` : ""}`}
      data-tier={node.tier}
      data-node-id={node.id}
      data-testid={`map-node-${node.id}`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <div className="mn-top">
        <span className={`health-dot${node.status !== "healthy" ? ` ${node.status}` : ""}`} />
        <span className="mn-name">{node.label}</span>
        {node.badges.map((badge, i) => (
          <span key={i} className={badge === "external" ? "mn-tag" : "mn-badge"}>
            {badge}
          </span>
        ))}
      </div>
      <NodeSubline node={node} />
    </div>
  );
}

function NodeSubline({ node }: { node: MapNodeType }) {
  // For entry_point: show subtitle with error rate colouring
  if (node.tier === "entry_point") {
    const errRate = typeof node.metrics["errorRate"] === "number"
      ? node.metrics["errorRate"]
      : null;
    return (
      <div className="mn-metrics">
        <span>{node.subtitle}</span>
        {errRate !== null && errRate > 0 && (
          <span className={errRate >= 0.5 ? "bad" : "warn"}>
            {Math.round(errRate * 100)}% err
          </span>
        )}
      </div>
    );
  }

  // For runtime_unit / dependency: show detail text with status colour
  if (node.subtitle) {
    const detailClass = node.status === "critical"
      ? " critical"
      : node.status === "degraded"
      ? " degraded"
      : "";
    return (
      <div className={`mn-detail${detailClass}`}>{node.subtitle}</div>
    );
  }

  return null;
}

function tierToClass(tier: string): string {
  switch (tier) {
    case "entry_point": return "n-entry";
    case "runtime_unit": return "n-unit";
    case "dependency": return "n-dep";
    default: return "";
  }
}
