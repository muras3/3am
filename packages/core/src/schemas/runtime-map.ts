import { z } from "zod";

export const CuratedStateSchema = z.object({
  diagnosis: z.enum(["ready", "pending", "unavailable"]),
  baseline: z.enum(["ready", "insufficient", "unavailable"]),
  evidenceDensity: z.enum(["rich", "sparse", "empty"]),
}).strict();

export const RuntimeMapStateSchema = CuratedStateSchema.pick({
  diagnosis: true,
}).strict();

export const RuntimeMapSummarySchema = z.object({
  activeIncidents: z.number(),
  degradedNodes: z.number(),
  clusterReqPerSec: z.number(),
  clusterP95Ms: z.number(),
}).strict();

export const RuntimeMapNodeSchema = z.object({
  id: z.string(),
  tier: z.enum(["entry_point", "runtime_unit", "dependency"]),
  label: z.string(),
  subtitle: z.string(),
  status: z.enum(["healthy", "degraded", "critical"]),
  metrics: z.record(z.string(), z.number()),
  badges: z.array(z.string()),
  incidentId: z.string().optional(),
  positionHint: z.number().optional(),
}).strict();

export const RuntimeMapEdgeSchema = z.object({
  fromNodeId: z.string(),
  toNodeId: z.string(),
  kind: z.enum(["internal", "external"]),
  status: z.enum(["healthy", "degraded", "critical"]),
  label: z.string().optional(),
  trafficHint: z.string().optional(),
}).strict();

export const RuntimeMapIncidentSchema = z.object({
  incidentId: z.string(),
  label: z.string(),
  severity: z.string(),
  openedAgo: z.string(),
}).strict();

export const RuntimeMapResponseSchema = z.object({
  summary: RuntimeMapSummarySchema,
  nodes: z.array(RuntimeMapNodeSchema),
  edges: z.array(RuntimeMapEdgeSchema),
  incidents: z.array(RuntimeMapIncidentSchema),
  state: RuntimeMapStateSchema,
}).strict();

export type CuratedState = z.infer<typeof CuratedStateSchema>;
export type RuntimeMapState = z.infer<typeof RuntimeMapStateSchema>;
export type RuntimeMapSummary = z.infer<typeof RuntimeMapSummarySchema>;
export type RuntimeMapResponse = z.infer<typeof RuntimeMapResponseSchema>;
export type RuntimeMapNode = z.infer<typeof RuntimeMapNodeSchema>;
export type RuntimeMapEdge = z.infer<typeof RuntimeMapEdgeSchema>;
export type RuntimeMapIncident = z.infer<typeof RuntimeMapIncidentSchema>;
