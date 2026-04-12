import { z } from "zod";

export const CuratedStateSchema = z.strictObject({
  diagnosis: z.enum(["ready", "pending", "unavailable"]),
  baseline: z.enum(["ready", "insufficient", "unavailable"]),
  evidenceDensity: z.enum(["rich", "sparse", "empty"]),
});

export const RuntimeMapStateSchema = z.strictObject({
  diagnosis: z.enum(["ready", "pending", "unavailable"]),
  source: z.enum(["recent_window", "incident_scope", "no_telemetry"]),
  windowLabel: z.string(),
  emptyReason: z.enum(["no_recent_spans", "no_preserved_incident_spans", "no_open_incidents"]).optional(),
  scopeIncidentId: z.string().optional(),
});

export const RuntimeMapSummarySchema = z.strictObject({
  activeIncidents: z.number(),
  degradedServices: z.number(),
  clusterReqPerSec: z.number(),
  clusterP95Ms: z.number(),
});

// ── Service-centric model ────────────────────────────────────────────────

const StatusEnum = z.enum(["healthy", "degraded", "critical"]);

export const RuntimeMapRouteSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  status: StatusEnum,
  errorRate: z.number(),
  reqPerSec: z.number(),
  incidentId: z.string().optional(),
});

export const RuntimeMapServiceSchema = z.strictObject({
  serviceName: z.string(),
  status: StatusEnum,
  routes: z.array(RuntimeMapRouteSchema),
  metrics: z.strictObject({
    errorRate: z.number(),
    p95Ms: z.number(),
    reqPerSec: z.number(),
  }),
  incidentId: z.string().optional(),
});

export const RuntimeMapDependencySchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  status: StatusEnum,
  errorRate: z.number(),
  reqPerSec: z.number(),
  incidentId: z.string().optional(),
});

export const RuntimeMapServiceEdgeSchema = z.strictObject({
  fromService: z.string(),
  toDependency: z.string(),
  status: StatusEnum,
});

export const RuntimeMapIncidentSchema = z.strictObject({
  incidentId: z.string(),
  label: z.string(),
  severity: z.string(),
  openedAgo: z.string(),
});

export const RuntimeMapResponseSchema = z.strictObject({
  summary: RuntimeMapSummarySchema,
  services: z.array(RuntimeMapServiceSchema),
  dependencies: z.array(RuntimeMapDependencySchema),
  edges: z.array(RuntimeMapServiceEdgeSchema),
  incidents: z.array(RuntimeMapIncidentSchema),
  state: RuntimeMapStateSchema,
});

// ── Exported types ───────────────────────────────────────────────────────

export type CuratedState = z.infer<typeof CuratedStateSchema>;
export type RuntimeMapState = z.infer<typeof RuntimeMapStateSchema>;
export type RuntimeMapSummary = z.infer<typeof RuntimeMapSummarySchema>;
export type RuntimeMapResponse = z.infer<typeof RuntimeMapResponseSchema>;
export type RuntimeMapRoute = z.infer<typeof RuntimeMapRouteSchema>;
export type RuntimeMapService = z.infer<typeof RuntimeMapServiceSchema>;
export type RuntimeMapDependency = z.infer<typeof RuntimeMapDependencySchema>;
export type RuntimeMapServiceEdge = z.infer<typeof RuntimeMapServiceEdgeSchema>;
export type RuntimeMapIncident = z.infer<typeof RuntimeMapIncidentSchema>;
