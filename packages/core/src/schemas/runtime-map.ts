import { z } from "zod";

// RuntimeMapResponse — GET /api/runtime-map
// Source: TelemetryStore (30min window), not SpanBuffer
// All sub-schemas use .strict() to reject unknown keys at every nesting level.

const RuntimeMapNodeSchema = z.object({
  id: z.string(), // "route:{svc}:{METHOD}:{path}" | "unit:{svc}:{name}" | "dep:{peer}"
  tier: z.enum(["entry_point", "runtime_unit", "dependency"]),
  label: z.string(),
  subtitle: z.string(),
  status: z.enum(["healthy", "degraded", "critical"]),
  metrics: z.object({
    errorRate: z.number(),
    p95Ms: z.number(),
    reqPerSec: z.number(),
  }).strict(),
  incidentId: z.string().optional(),
}).strict();

const RuntimeMapEdgeSchema = z.object({
  fromNodeId: z.string(),
  toNodeId: z.string(),
  kind: z.enum(["internal", "external"]),
  status: z.enum(["healthy", "degraded", "critical"]),
  requestCount: z.number(),
}).strict();

const RuntimeMapIncidentSchema = z.object({
  incidentId: z.string(),
  label: z.string(),
  severity: z.string(),
  openedAt: z.string(),
}).strict();

export const RuntimeMapResponseSchema = z.object({
  summary: z.object({
    activeIncidents: z.number(),
    degradedNodes: z.number(),
    clusterReqPerSec: z.number(),
    clusterP95Ms: z.number(),
  }).strict(),
  nodes: z.array(RuntimeMapNodeSchema),
  edges: z.array(RuntimeMapEdgeSchema),
  incidents: z.array(RuntimeMapIncidentSchema),
  window: z.object({
    startMs: z.number(),
    endMs: z.number(),
    spanCount: z.number(),
  }).strict(),
  state: z.object({
    coverage: z.enum(["normal", "sparse", "cold_start"]),
  }).strict(),
}).strict();

export type RuntimeMapResponse = z.infer<typeof RuntimeMapResponseSchema>;
export type RuntimeMapNode = z.infer<typeof RuntimeMapNodeSchema>;
export type RuntimeMapEdge = z.infer<typeof RuntimeMapEdgeSchema>;
export type RuntimeMapIncident = z.infer<typeof RuntimeMapIncidentSchema>;
