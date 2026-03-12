const STATIC_SERVICES = [
  { name: "api-gateway", status: "healthy", lastSeen: "03:00:12" },
  { name: "auth-service", status: "healthy", lastSeen: "03:00:08" },
  { name: "stripe-proxy", status: "degraded", lastSeen: "02:58:44" },
] as const;

type ServiceStatus = "healthy" | "degraded";

export function NormalSurface() {
  const degradedCount = STATIC_SERVICES.filter((s) => s.status === "degraded").length;
  const systemState = degradedCount === 0 ? "All systems nominal" : `${degradedCount} service degraded`;

  return (
    <div className="normal-surface">
      <div className="normal-surface-lead">
        <span
          className={`normal-surface-indicator normal-surface-indicator--${degradedCount === 0 ? "ok" : "warn"}`}
        />
        <span className="normal-surface-headline">{systemState}</span>
        <span className="normal-surface-count">{STATIC_SERVICES.length}&nbsp;services</span>
      </div>

      <ul className="normal-surface-grid">
        {STATIC_SERVICES.map((svc) => (
          <ServiceCard key={svc.name} {...svc} />
        ))}
      </ul>
    </div>
  );
}

function ServiceCard({
  name,
  status,
  lastSeen,
}: {
  name: string;
  status: ServiceStatus;
  lastSeen: string;
}) {
  return (
    <li className={`service-card service-card--${status}`}>
      <span className={`service-dot service-dot--${status}`} aria-hidden="true" />
      <span className="service-name">{name}</span>
      <span className="service-status">{status}</span>
      <time className="service-time" dateTime={`2026-03-12T${lastSeen}`}>
        {lastSeen}
      </time>
    </li>
  );
}
