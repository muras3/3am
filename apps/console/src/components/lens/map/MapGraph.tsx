import type { MapNode as MapNodeType, MapEdge } from "../../../api/curated-types.js";
import type { LensLevel } from "../../../routes/__root.js";
import { MapNode } from "./MapNode.js";

interface Props {
  nodes: MapNodeType[];
  edges: MapEdge[];
  zoomTo: (level: LensLevel, trigger?: HTMLElement, incidentId?: string) => void;
}

// Layout constants (matching the mock's 1100x380 coordinate space)
const SVG_W = 1100;
const SVG_H = 380;

// Tier Y positions (center of each node card)
const TIER_Y: Record<string, number> = {
  entry_point: 20,
  runtime_unit: 150,
  dependency: 280,
};

// Tier divider Y positions
const TIER_DIVIDERS = [120, 252];

// Node card dimensions
const NODE_W = 160;
const NODE_H = 58;
const LEFT_OFFSET = 28; // leave room for tier labels

/**
 * MapGraph — SVG-backed dependency map with tier-based auto layout.
 *
 * Tiers:
 * - Tier 0 (entry_point): top row
 * - Tier 1 (runtime_unit): middle row
 * - Tier 2 (dependency): bottom row
 *
 * Nodes are positioned absolutely within a 1100×380 container.
 * SVG edges are drawn behind nodes and animate traffic dots via animateMotion.
 */
export function MapGraph({ nodes, edges, zoomTo }: Props) {
  const nodePositions = computeNodePositions(nodes);

  return (
    <div className="system-map" aria-label="Runtime dependency map">
      {/* Tier labels */}
      <span className="map-tier-label t0">Entry Points</span>
      <span className="map-tier-label t1">Runtime Units</span>
      <span className="map-tier-label t2">Dependencies</span>

      {/* Tier dividers */}
      {TIER_DIVIDERS.map((top) => (
        <div key={top} className="map-tier-border" style={{ top }} />
      ))}

      {/* SVG edges */}
      <svg
        className="map-edges"
        viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
        <defs>
          {edges.map((edge, i) => {
            const path = computeEdgePath(edge, nodePositions);
            if (!path) return null;
            return <path key={`path-def-${i}`} id={`e${i}`} d={path} fill="none" />;
          })}
        </defs>

        {edges.map((edge, i) => {
          const path = computeEdgePath(edge, nodePositions);
          if (!path) return null;
          const color = statusColor(edge.status);
          const opacity = edge.status === "healthy" ? 0.16 : 0.22;
          const strokeW = edge.status === "critical" ? 2.5 : edge.status === "degraded" ? 2 : 1.5;
          const dashed = edge.kind === "external" ? "6 4" : undefined;
          const dotColor = statusDotColor(edge.status);
          const dotR = edge.status === "critical" ? 3 : 2.5;
          const dotOpacity = edge.status === "critical" ? 0.7 : edge.status === "degraded" ? 0.5 : 0.4;
          const dur = edge.status === "critical" ? "0.9s" : edge.status === "degraded" ? "1.5s" : "2.5s";
          const dotsCount = edge.status === "critical" ? 3 : 1;

          return (
            <g key={`edge-${i}`}>
              <path
                d={path}
                stroke={color}
                strokeWidth={strokeW}
                opacity={opacity}
                fill="none"
                strokeDasharray={dashed}
              />
              {edge.label && (
                <EdgeLabel path={path} label={edge.label} />
              )}
              {Array.from({ length: dotsCount }, (_, di) => (
                <circle key={di} r={dotR} fill={dotColor} opacity={dotOpacity}>
                  <animateMotion
                    dur={dur}
                    begin={di > 0 ? `${di * (parseFloat(dur) / dotsCount)}s` : undefined}
                    repeatCount="indefinite"
                  >
                    <mpath href={`#e${i}`} />
                  </animateMotion>
                </circle>
              ))}
            </g>
          );
        })}
      </svg>

      {/* Nodes */}
      {nodes.map((node) => {
        const pos = nodePositions.get(node.id);
        if (!pos) return null;
        return (
          <MapNode
            key={node.id}
            node={node}
            style={{ left: pos.x, top: pos.y, width: NODE_W }}
            zoomTo={zoomTo}
          />
        );
      })}

      {/* Map legend */}
      <div className="map-legend">
        <span style={{ color: "var(--ink-2)" }}>Observed from spans</span>
        <span>&#9644; entry point</span>
        <span>&#9673; runtime unit</span>
        <span>&#9634; dependency</span>
        <span>
          <span className="legend-line" style={{ background: "var(--accent)" }} />
          errors
        </span>
        <span>
          <span className="legend-line" style={{ background: "var(--amber)" }} />
          degraded
        </span>
        <span>
          <span className="legend-line" style={{ background: "var(--good)" }} />
          healthy
        </span>
      </div>
    </div>
  );
}

// ── Layout helpers ─────────────────────────────────────────────

interface NodePos {
  x: number;
  y: number;
  cx: number; // center x (for edge attachment)
  cy: number; // center y
}

function computeNodePositions(nodes: MapNodeType[]): Map<string, NodePos> {
  const byTier: Record<string, MapNodeType[]> = {
    entry_point: [],
    runtime_unit: [],
    dependency: [],
  };

  for (const node of nodes) {
    const tier = byTier[node.tier];
    if (tier) tier.push(node);
  }

  // Sort within tier by positionHint if available
  for (const tier of Object.values(byTier)) {
    tier.sort((a, b) => {
      const ah = a.positionHint ?? 999;
      const bh = b.positionHint ?? 999;
      return ah - bh;
    });
  }

  const result = new Map<string, NodePos>();
  const usableWidth = SVG_W - LEFT_OFFSET - 20; // leave right margin

  for (const [tierName, tierNodes] of Object.entries(byTier)) {
    if (tierNodes.length === 0) continue;
    const topY = TIER_Y[tierName] ?? 0;
    const spacing = usableWidth / (tierNodes.length + 1);

    tierNodes.forEach((node, idx) => {
      const x = LEFT_OFFSET + spacing * (idx + 1) - NODE_W / 2;
      const y = topY;
      result.set(node.id, {
        x,
        y,
        cx: x + NODE_W / 2,
        cy: y + NODE_H / 2,
      });
    });
  }

  return result;
}

function computeEdgePath(
  edge: MapEdge,
  positions: Map<string, NodePos>,
): string | null {
  const from = positions.get(edge.fromNodeId);
  const to = positions.get(edge.toNodeId);
  if (!from || !to) return null;

  // Connect from bottom-center of source to top-center of target
  const x1 = from.cx;
  const y1 = from.y + NODE_H;
  const x2 = to.cx;
  const y2 = to.y;

  return `M${x1},${y1} L${x2},${y2}`;
}

// ── Color helpers ──────────────────────────────────────────────

function statusColor(status: string): string {
  switch (status) {
    case "critical": return "var(--accent)";
    case "degraded": return "var(--amber)";
    default: return "var(--good)";
  }
}

function statusDotColor(status: string): string {
  return statusColor(status);
}

// ── Edge label ────────────────────────────────────────────────

function EdgeLabel({ path, label }: { path: string; label: string }) {
  // Parse midpoint from "Mx1,y1 Lx2,y2"
  const parts = path.replace(/[ML]/g, "").trim().split(" ");
  if (parts.length < 2) return null;
  const p1 = parts[0]!.split(",").map(Number);
  const p2 = parts[1]!.split(",").map(Number);
  if (p1.length < 2 || p2.length < 2) return null;
  const mx = ((p1[0] ?? 0) + (p2[0] ?? 0)) / 2;
  const my = ((p1[1] ?? 0) + (p2[1] ?? 0)) / 2;

  return (
    <text
      x={mx}
      y={my}
      fontSize="8"
      fill="var(--ink-3)"
      fontFamily="var(--mono)"
      textAnchor="middle"
    >
      {label}
    </text>
  );
}
