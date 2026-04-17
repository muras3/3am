import type { RuntimeMapResponse } from "../../api/curated-types.js";

/** Happy path: Stripe rate limit cascade scenario — 1 service, 2 deps, 2 incidents */
export const runtimeMapReady: RuntimeMapResponse = {
  summary: {
    activeIncidents: 2,
    degradedServices: 1,
    clusterReqPerSec: 866,
    clusterP95Ms: 89,
  },
  services: [
    {
      serviceName: "web",
      status: "critical",
      routes: [
        { id: "route:web:POST:/checkout", label: "POST /checkout", status: "critical", errorRate: 0.682, reqPerSec: 189, incidentId: "inc_0892" },
        { id: "route:web:GET:/orders", label: "GET /orders", status: "degraded", errorRate: 0.23, reqPerSec: 312 },
        { id: "route:web:GET:/dashboard", label: "GET /dashboard", status: "healthy", errorRate: 0, reqPerSec: 365 },
      ],
      metrics: { errorRate: 0.31, p95Ms: 89, reqPerSec: 866 },
      incidentId: "inc_0892",
    },
  ],
  dependencies: [
    { id: "dep:stripe-api", name: "Stripe API", status: "critical", errorRate: 0.68, reqPerSec: 189, incidentId: "inc_0892" },
    { id: "dep:postgresql", name: "PostgreSQL", status: "healthy", errorRate: 0, reqPerSec: 501 },
  ],
  edges: [
    { fromService: "web", toDependency: "dep:stripe-api", status: "critical" },
    { fromService: "web", toDependency: "dep:postgresql", status: "healthy" },
  ],
  incidents: [
    { incidentId: "inc_0892", label: "Stripe Rate Limit Cascade", severity: "critical", openedAgo: "8m" },
    { incidentId: "inc_0891", label: "Order Timeout Degradation", severity: "medium", openedAgo: "14m" },
  ],
  state: { diagnosis: "ready", source: "recent_window", windowLabel: "last 30m" },
};

/** Sparse: single service, single route, single dep */
export const runtimeMapSparse: RuntimeMapResponse = {
  summary: {
    activeIncidents: 0,
    degradedServices: 0,
    clusterReqPerSec: 42,
    clusterP95Ms: 15,
  },
  services: [
    {
      serviceName: "api",
      status: "healthy",
      routes: [
        { id: "route:api:GET:/health", label: "GET /health", status: "healthy", errorRate: 0, reqPerSec: 42 },
      ],
      metrics: { errorRate: 0, p95Ms: 15, reqPerSec: 42 },
    },
  ],
  dependencies: [
    { id: "dep:postgresql", name: "PostgreSQL", status: "healthy", errorRate: 0, reqPerSec: 38 },
  ],
  edges: [
    { fromService: "api", toDependency: "dep:postgresql", status: "healthy" },
  ],
  incidents: [],
  state: { diagnosis: "ready", source: "recent_window", windowLabel: "last 30m" },
};

/** Unavailable: no traffic observed yet */
export const runtimeMapUnavailable: RuntimeMapResponse = {
  summary: {
    activeIncidents: 2,
    degradedServices: 0,
    clusterReqPerSec: 0,
    clusterP95Ms: 0,
  },
  services: [],
  dependencies: [],
  edges: [],
  incidents: [
    { incidentId: "inc_070c0148", label: "Stripe 429s exhausted checkout retries.", severity: "critical", openedAgo: "43m" },
    { incidentId: "inc_413bde8a", label: "Diagnosis pending for api timeout burst.", severity: "medium", openedAgo: "1h" },
  ],
  state: {
    diagnosis: "ready",
    source: "no_telemetry",
    windowLabel: "last 30m",
    emptyReason: "no_preserved_incident_spans",
  },
};

/** Fallback: live window empty, incident-scoped spans available */
export const runtimeMapIncidentFallback: RuntimeMapResponse = {
  summary: {
    activeIncidents: 2,
    degradedServices: 1,
    clusterReqPerSec: 24,
    clusterP95Ms: 611,
  },
  services: [
    {
      serviceName: "web",
      status: "critical",
      routes: [
        { id: "route:web:POST:/checkout", label: "POST /checkout", status: "critical", errorRate: 0.44, reqPerSec: 24, incidentId: "inc_070c0148" },
      ],
      metrics: { errorRate: 0.44, p95Ms: 611, reqPerSec: 24 },
      incidentId: "inc_070c0148",
    },
  ],
  dependencies: [
    { id: "dep:stripe", name: "Stripe", status: "critical", errorRate: 0.44, reqPerSec: 24, incidentId: "inc_070c0148" },
  ],
  edges: [
    { fromService: "web", toDependency: "dep:stripe", status: "critical" },
  ],
  incidents: runtimeMapUnavailable.incidents,
  state: {
    diagnosis: "ready",
    source: "incident_scope",
    windowLabel: "captured incident window \u00b7 070C",
    scopeIncidentId: "inc_070c0148",
  },
};
