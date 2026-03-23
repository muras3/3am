import type { RuntimeMapResponse } from "../../api/curated-types.js";

/** Happy path: Stripe rate limit cascade scenario — 5 nodes, 6 edges, 2 incidents */
export const runtimeMapReady: RuntimeMapResponse = {
  summary: {
    activeIncidents: 2,
    degradedNodes: 2,
    clusterReqPerSec: 866,
    clusterP95Ms: 89,
  },
  nodes: [
    {
      id: "route:POST:/checkout",
      tier: "entry_point",
      label: "POST /checkout",
      subtitle: "189 req/s",
      status: "critical",
      metrics: { errorRate: 0.682 },
      badges: ["68% err"],
      incidentId: "inc_0892",
    },
    {
      id: "route:GET:/orders",
      tier: "entry_point",
      label: "GET /orders",
      subtitle: "312 req/s",
      status: "degraded",
      metrics: { errorRate: 0.23 },
      badges: ["23% err"],
    },
    {
      id: "unit:StripeClient",
      tier: "runtime_unit",
      label: "StripeClient",
      subtitle: "189 calls/s — 1:1 per tx",
      status: "critical",
      metrics: {},
      badges: ["no batching"],
      incidentId: "inc_0892",
    },
    {
      id: "dep:stripe-api",
      tier: "dependency",
      label: "Stripe API",
      subtitle: "429 — quota 0/100",
      status: "critical",
      metrics: {},
      badges: ["external"],
    },
    {
      id: "dep:postgresql",
      tier: "dependency",
      label: "PostgreSQL",
      subtitle: "p95 12ms",
      status: "healthy",
      metrics: {},
      badges: ["external"],
    },
  ],
  edges: [
    { fromNodeId: "route:POST:/checkout", toNodeId: "unit:StripeClient", kind: "internal", status: "critical" },
    { fromNodeId: "route:GET:/orders", toNodeId: "unit:StripeClient", kind: "internal", status: "degraded" },
    { fromNodeId: "unit:StripeClient", toNodeId: "dep:stripe-api", kind: "external", status: "critical", label: "timeout" },
    { fromNodeId: "route:POST:/checkout", toNodeId: "dep:postgresql", kind: "external", status: "healthy" },
    { fromNodeId: "route:GET:/orders", toNodeId: "dep:postgresql", kind: "external", status: "healthy" },
    { fromNodeId: "unit:StripeClient", toNodeId: "dep:postgresql", kind: "external", status: "healthy" },
  ],
  incidents: [
    { incidentId: "inc_0892", label: "Stripe Rate Limit Cascade", severity: "critical", openedAgo: "8m" },
    { incidentId: "inc_0891", label: "Order Timeout Degradation", severity: "medium", openedAgo: "14m" },
  ],
  state: { diagnosis: "ready", source: "recent_window", windowLabel: "last 30m" },
};

/** Sparse: single node, no edges */
export const runtimeMapSparse: RuntimeMapResponse = {
  summary: {
    activeIncidents: 0,
    degradedNodes: 0,
    clusterReqPerSec: 42,
    clusterP95Ms: 15,
  },
  nodes: [
    {
      id: "route:GET:/health",
      tier: "entry_point",
      label: "GET /health",
      subtitle: "42 req/s",
      status: "healthy",
      metrics: { errorRate: 0 },
      badges: [],
    },
  ],
  edges: [],
  incidents: [],
  state: { diagnosis: "ready", source: "recent_window", windowLabel: "last 30m" },
};

/** Unavailable: no traffic observed yet */
export const runtimeMapUnavailable: RuntimeMapResponse = {
  summary: {
    activeIncidents: 2,
    degradedNodes: 0,
    clusterReqPerSec: 0,
    clusterP95Ms: 0,
  },
  nodes: [],
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
    degradedNodes: 3,
    clusterReqPerSec: 24,
    clusterP95Ms: 611,
  },
  nodes: [
    {
      id: "route:web:POST:/checkout",
      tier: "entry_point",
      label: "POST /checkout",
      subtitle: "24.0 req/s",
      status: "critical",
      metrics: { errorRate: 0.44, p95Ms: 611, reqPerSec: 24 },
      badges: ["44% err"],
      incidentId: "inc_070c0148",
    },
    {
      id: "unit:web:stripe.charges.create",
      tier: "runtime_unit",
      label: "stripe.charges.create",
      subtitle: "24.0 req/s",
      status: "critical",
      metrics: { errorRate: 0.44, p95Ms: 402, reqPerSec: 24 },
      badges: ["44% err"],
      incidentId: "inc_070c0148",
    },
    {
      id: "dep:stripe",
      tier: "dependency",
      label: "stripe",
      subtitle: "external",
      status: "critical",
      metrics: { errorRate: 0.44, p95Ms: 402, reqPerSec: 24 },
      badges: ["44% err"],
      incidentId: "inc_070c0148",
    },
  ],
  edges: [
    { fromNodeId: "route:web:POST:/checkout", toNodeId: "unit:web:stripe.charges.create", kind: "internal", status: "critical", trafficHint: "12" },
    { fromNodeId: "unit:web:stripe.charges.create", toNodeId: "dep:stripe", kind: "external", status: "critical", trafficHint: "12" },
  ],
  incidents: runtimeMapUnavailable.incidents,
  state: {
    diagnosis: "ready",
    source: "incident_scope",
    windowLabel: "captured incident window · 070C",
    scopeIncidentId: "inc_070c0148",
  },
};
