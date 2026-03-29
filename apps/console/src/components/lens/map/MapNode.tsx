import type { MapService, MapRoute, MapDependency } from "../../../api/curated-types.js";
import type { LensLevel } from "../../../routes/__root.js";

// ── Service card ──────────────────────────────────────────────

interface ServiceCardProps {
  service: MapService;
  zoomTo: (level: LensLevel, trigger?: HTMLElement, incidentId?: string) => void;
}

export function ServiceCard({ service, zoomTo }: ServiceCardProps) {
  const statusClass =
    service.status === "critical" ? "has-error" :
    service.status === "degraded" ? "has-warn" : "";

  return (
    <div
      className={`svc-card ${statusClass}`.trim()}
      data-testid={`svc-card-${service.serviceName}`}
    >
      <div className="svc-header">
        <span className={`dot ${dotClass(service.status)}`} />
        <span className="svc-name" title={service.serviceName}>{service.serviceName}</span>
        <span className="svc-meta">
          <span>{formatRps(service.metrics.reqPerSec)}</span>
          <span>p95 {Math.round(service.metrics.p95Ms)}ms</span>
        </span>
      </div>
      <div className="route-list">
        {service.routes.map((route) => (
          <RouteRow key={route.id} route={route} zoomTo={zoomTo} />
        ))}
      </div>
    </div>
  );
}

// ── Route row ─────────────────────────────────────────────────

interface RouteRowProps {
  route: MapRoute;
  zoomTo: (level: LensLevel, trigger?: HTMLElement, incidentId?: string) => void;
}

function RouteRow({ route, zoomTo }: RouteRowProps) {
  const isClickable = !!route.incidentId;
  const rowClass = [
    "route-row",
    route.status === "critical" ? "is-critical" : "",
    route.status === "degraded" ? "is-degraded" : "",
    isClickable ? "clickable" : "",
  ].filter(Boolean).join(" ");

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (isClickable) {
      zoomTo(1, e.currentTarget, route.incidentId);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (isClickable && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      zoomTo(1, e.currentTarget as HTMLElement, route.incidentId);
    }
  }

  return (
    <div
      className={rowClass}
      tabIndex={isClickable ? 0 : undefined}
      role={isClickable ? "button" : undefined}
      aria-label={`${route.label}${route.status !== "healthy" ? ` \u2014 ${route.status}` : ""}`}
      data-testid={`route-row-${route.id}`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <span className={`dot ${dotClass(route.status)}`} />
      <span className="route-label">{route.label}</span>
      {route.errorRate > 0 && (
        <span className={`route-err${route.status === "degraded" ? " warn" : ""}`}>
          {formatErrRate(route.errorRate)} err
        </span>
      )}
      <span className="route-rps">{formatRps(route.reqPerSec)}</span>
    </div>
  );
}

// ── Dependency card ───────────────────────────────────────────

interface DependencyCardProps {
  dep: MapDependency;
  zoomTo: (level: LensLevel, trigger?: HTMLElement, incidentId?: string) => void;
}

export function DependencyCard({ dep, zoomTo }: DependencyCardProps) {
  const statusClass = dep.status === "critical" ? "has-error" : "";
  const isClickable = !!dep.incidentId;

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (isClickable) {
      zoomTo(1, e.currentTarget, dep.incidentId);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (isClickable && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      zoomTo(1, e.currentTarget as HTMLElement, dep.incidentId);
    }
  }

  return (
    <div
      className={`dep-card ${statusClass}${isClickable ? " clickable" : ""}`.trim()}
      tabIndex={isClickable ? 0 : undefined}
      role={isClickable ? "button" : undefined}
      aria-label={`${dep.name}${dep.status !== "healthy" ? ` \u2014 ${dep.status}` : ""}`}
      data-testid={`dep-card-${dep.id}`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <div className="dep-header">
        <span className={`dot ${dotClass(dep.status)}`} />
        <span className="dep-name" title={dep.name}>{dep.name}</span>
        <span className="dep-tag">External</span>
      </div>
      <div className="dep-metrics">
        {dep.errorRate > 0 && (
          <span className="bad">{formatErrRate(dep.errorRate)} errors</span>
        )}
        <span>{formatRps(dep.reqPerSec)}</span>
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────

/**
 * Format an error rate (0–1) for compact display.
 * - 0 → never shown (callers guard with `> 0`)
 * - < 0.005 (< 0.5%) → "<1%"    (rounds to 0 with Math.round, so use a floor guard)
 * - 100% → "100%"
 * - otherwise → "N%" with no decimals
 */
function formatErrRate(rate: number): string {
  const pct = rate * 100;
  if (pct < 0.5) return "<1%";
  if (pct >= 99.5) return "100%";
  return `${Math.round(pct)}%`;
}

/**
 * Format req/s: show integer unless < 1, then show one decimal.
 * Zero stays "0/s".
 */
function formatRps(rps: number): string {
  if (rps === 0) return "0/s";
  if (rps < 1) return `${rps.toFixed(1)}/s`;
  return `${Math.round(rps)}/s`;
}

function dotClass(status: string): string {
  switch (status) {
    case "critical": return "crit";
    case "degraded": return "deg";
    default: return "ok";
  }
}
