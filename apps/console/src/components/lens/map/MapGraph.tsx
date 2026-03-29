import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { MapService, MapDependency, MapEdge } from "../../../api/curated-types.js";
import type { LensLevel } from "../../../routes/__root.js";
import { ServiceCard, DependencyCard } from "./MapNode.js";

interface Props {
  services: MapService[];
  dependencies: MapDependency[];
  edges: MapEdge[];
  emptyState?: ReactNode;
  zoomTo: (level: LensLevel, trigger?: HTMLElement, incidentId?: string) => void;
}

/**
 * MapGraph -- 3-zone layout: services (left), SVG edges (center), dependencies (right).
 *
 * Replaces the previous tier-based SVG coordinate space with a flex-based
 * spatial layout matching the v2 mock design.
 */
export function MapGraph({ services, dependencies, edges, emptyState, zoomTo }: Props) {
  const { t } = useTranslation();
  const hasContent = services.length > 0 || dependencies.length > 0;

  return (
    <div className="system-map" aria-label={t("map.mapLabel")}>
      {hasContent ? (
        <div className="map-zoned">
          {/* Left: Services */}
          <div className="zone-services">
            {services.map((svc) => (
              <ServiceCard key={svc.serviceName} service={svc} zoomTo={zoomTo} />
            ))}
          </div>

          {/* Center: SVG edges — hidden when no dependencies */}
          <EdgeZone
            services={services}
            dependencies={dependencies}
            edges={edges}
            hasDependencies={dependencies.length > 0}
          />

          {/* Right: Dependencies — zone-deps:empty collapses via CSS */}
          <div className="zone-deps">
            {dependencies.map((dep) => (
              <DependencyCard key={dep.id} dep={dep} zoomTo={zoomTo} />
            ))}
          </div>
        </div>
      ) : null}

      {!hasContent && emptyState ? (
        <div className="map-empty map-empty-overlay">
          {emptyState}
        </div>
      ) : null}

      {/* Legend */}
      <div className="map-legend">
        <span>
          <span className="legend-swatch" style={{ background: "var(--good)" }} />
          {t("map.legendHealthy")}
        </span>
        <span>
          <span className="legend-swatch" style={{ background: "var(--amber)" }} />
          {t("map.legendDegraded")}
        </span>
        <span>
          <span className="legend-swatch" style={{ background: "var(--accent)" }} />
          {t("map.legendErrors")}
        </span>
        <span>
          <span className="legend-line-dashed" />
          {t("map.legendDependency")}
        </span>
      </div>
    </div>
  );
}

// ── Edge zone ─────────────────────────────────────────────────

/** Estimated vertical height per service card (header + ~2 routes avg). */
const SVC_CARD_H = 100;
/** Gap between service cards. */
const SVC_GAP = 10;
/** Estimated vertical height per dependency card. */
const DEP_CARD_H = 70;
/** Gap between dependency cards. */
const DEP_GAP = 10;

interface EdgeZoneProps {
  services: MapService[];
  dependencies: MapDependency[];
  edges: MapEdge[];
  hasDependencies: boolean;
}

function EdgeZone({ services, dependencies, edges, hasDependencies }: EdgeZoneProps) {
  if (!hasDependencies) return null;
  if (edges.length === 0) return <div className="zone-edges" />;

  // Build index maps for y-position calculation
  const svcIndex = new Map<string, number>();
  services.forEach((svc, i) => svcIndex.set(svc.serviceName, i));

  const depIndex = new Map<string, number>();
  dependencies.forEach((dep, i) => depIndex.set(dep.id, i));

  // Compute estimated service card heights based on route count
  const svcHeights = services.map((svc) => {
    const headerH = 38;         // svc-header height
    const routeH = 28;          // each route-row
    const routeListPad = 6;     // padding in route-list
    return headerH + routeListPad + svc.routes.length * routeH + 2; // 2px border
  });

  // Y center of each service card
  const svcCenters: number[] = [];
  let runningY = 0;
  for (let i = 0; i < svcHeights.length; i++) {
    svcCenters.push(runningY + svcHeights[i]! / 2);
    runningY += svcHeights[i]! + SVC_GAP;
  }

  // Y center of each dependency card
  const depCenters: number[] = [];
  let depRunningY = 0;
  for (let i = 0; i < dependencies.length; i++) {
    depCenters.push(depRunningY + DEP_CARD_H / 2);
    depRunningY += DEP_CARD_H + DEP_GAP;
  }

  const totalSvcH = runningY > 0 ? runningY - SVC_GAP : SVC_CARD_H;
  const totalDepH = depRunningY > 0 ? depRunningY - DEP_GAP : DEP_CARD_H;
  const svgH = Math.max(totalSvcH, totalDepH, 60);
  const svgW = 72;

  return (
    <div className="zone-edges">
      <svg
        viewBox={`0 0 ${svgW} ${svgH}`}
        fill="none"
        style={{ height: svgH }}
        aria-hidden="true"
      >
        {edges.map((edge, i) => {
          const si = svcIndex.get(edge.fromService);
          const di = depIndex.get(edge.toDependency);
          if (si === undefined || di === undefined) return null;

          const y1 = svcCenters[si] ?? svgH / 2;
          const y2 = depCenters[di] ?? svgH / 2;

          const isCrit = edge.status === "critical";
          const color = statusColor(edge.status);
          const strokeW = isCrit ? 1.5 : 1.2;
          const opacity = isCrit ? 0.7 : edge.status === "degraded" ? 0.4 : 0.3;
          const dotR = isCrit ? 3 : 2.5;
          const dotOpacity = isCrit ? 0.6 : 0.35;
          const dur = isCrit ? "1s" : edge.status === "degraded" ? "1.5s" : "2.5s";

          const path = `M0,${y1} C${svgW * 0.42},${y1} ${svgW * 0.58},${y2} ${svgW},${y2}`;
          const pathId = `edge-path-${i}`;

          return (
            <g key={i}>
              <defs>
                <path id={pathId} d={path} />
              </defs>
              <path
                d={path}
                stroke={color}
                strokeWidth={strokeW}
                strokeDasharray="5 3.5"
                opacity={opacity}
                fill="none"
              />
              {/* Critical edges get 3 staggered dots for urgency; others get 1 */}
              {isCrit ? (
                <>
                  <circle r={dotR} fill={color} opacity={dotOpacity}>
                    <animateMotion dur={dur} repeatCount="indefinite" begin="0s">
                      <mpath href={`#${pathId}`} />
                    </animateMotion>
                  </circle>
                  <circle r={dotR} fill={color} opacity={dotOpacity * 0.7}>
                    <animateMotion dur={dur} repeatCount="indefinite" begin={`${parseFloat(dur) * 0.33}s`}>
                      <mpath href={`#${pathId}`} />
                    </animateMotion>
                  </circle>
                  <circle r={dotR} fill={color} opacity={dotOpacity * 0.45}>
                    <animateMotion dur={dur} repeatCount="indefinite" begin={`${parseFloat(dur) * 0.66}s`}>
                      <mpath href={`#${pathId}`} />
                    </animateMotion>
                  </circle>
                </>
              ) : (
                <circle r={dotR} fill={color} opacity={dotOpacity}>
                  <animateMotion dur={dur} repeatCount="indefinite">
                    <mpath href={`#${pathId}`} />
                  </animateMotion>
                </circle>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── Color helpers ─────────────────────────────────────────────

function statusColor(status: string): string {
  switch (status) {
    case "critical": return "var(--accent)";
    case "degraded": return "var(--amber)";
    default: return "var(--good)";
  }
}
