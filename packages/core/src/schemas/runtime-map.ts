import { z } from "zod";

export const CuratedStateSchema = z.object({
  diagnosis: z.enum(["ready", "pending", "unavailable"]),
  baseline: z.enum(["ready", "insufficient", "unavailable"]),
  evidenceDensity: z.enum(["rich", "sparse", "empty"]),
}).strict();

export const RuntimeMapStateSchema = CuratedStateSchema.pick({
  diagnosis: true,
}).extend({
  source: z.enum(["recent_window", "incident_scope", "no_telemetry"]),
  windowLabel: z.string(),
  emptyReason: z.enum(["no_recent_spans", "no_preserved_incident_spans", "no_open_incidents"]).optional(),
  scopeIncidentId: z.string().optional(),
}).strict();

export const RuntimeMapSummarySchema = z.object({
  activeIncidents: z.number(),
  degradedServices: z.number(),
  clusterReqPerSec: z.number(),
  clusterP95Ms: z.number(),
}).strict();

// ── Service-centric model ────────────────────────────────────────────────

const StatusEnum = z.enum(["healthy", "degraded", "critical"]);

export const RuntimeMapRouteSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: StatusEnum,
  errorRate: z.number(),
  reqPerSec: z.number(),
  incidentId: z.string().optional(),
}).strict();

export const RuntimeMapServiceSchema = z.object({
  serviceName: z.string(),
  status: StatusEnum,
  routes: z.array(RuntimeMapRouteSchema),
  metrics: z.object({
    errorRate: z.number(),
    p95Ms: z.number(),
    reqPerSec: z.number(),
  }).strict(),
  incidentId: z.string().optional(),
}).strict();

export const RuntimeMapDependencySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: StatusEnum,
  errorRate: z.number(),
  reqPerSec: z.number(),
  incidentId: z.string().optional(),
}).strict();

export const RuntimeMapServiceEdgeSchema = z.object({
  fromService: z.string(),
  toDependency: z.string(),
  status: StatusEnum,
}).strict();

export const RuntimeMapIncidentSchema = z.object({
  incidentId: z.string(),
  label: z.string(),
  severity: z.string(),
  openedAgo: z.string(),
}).strict();

export const RuntimeMapResponseSchema = z.object({
  summary: RuntimeMapSummarySchema,
  services: z.array(RuntimeMapServiceSchema),
  dependencies: z.array(RuntimeMapDependencySchema),
  edges: z.array(RuntimeMapServiceEdgeSchema),
  incidents: z.array(RuntimeMapIncidentSchema),
  state: RuntimeMapStateSchema,
}).strict();

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
