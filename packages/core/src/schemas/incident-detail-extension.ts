import { z } from "zod";

// IncidentDetailExtension — added to GET /api/incidents/:id response
// All sub-schemas use .strict() to reject unknown keys at every nesting level.

const CorrelationEntrySchema = z.object({
  metricName: z.string(),
  service: z.string(),
  correlationValue: z.number(),
  pValue: z.number().optional(),
}).strict();

const ConfidencePrimitivesSchema = z.object({
  evidenceCoverage: z.object({
    traceCount: z.number(),
    metricCount: z.number(),
    logCount: z.number(),
    baselineSampleCount: z.number(),
  }).strict(),
  correlations: z.array(CorrelationEntrySchema),
  baselineConfidence: z.enum(["high", "medium", "low", "unavailable"]),
}).strict();

const BlastRadiusEntrySchema = z.object({
  targetId: z.string(),
  label: z.string(),
  status: z.enum(["healthy", "degraded", "critical"]),
  impactMetric: z.literal("error_rate"),
  impactValue: z.number(),
  displayValue: z.string(),
}).strict();

const BlastRadiusRollupSchema = z.object({
  healthyCount: z.number(),
  label: z.string(),
}).strict();

export const IncidentDetailExtensionSchema = z.object({
  impactSummary: z.object({
    startedAt: z.string(),
    fullCascadeAt: z.string().optional(),
    diagnosedAt: z.string().optional(),
  }).strict(),
  blastRadius: z.array(BlastRadiusEntrySchema),
  blastRadiusRollup: BlastRadiusRollupSchema,
  confidencePrimitives: ConfidencePrimitivesSchema,
  evidenceSummary: z.object({
    traces: z.number(),
    traceErrors: z.number(),
    metrics: z.number(),
    metricsAnomalous: z.number(),
    logs: z.number(),
    logErrors: z.number(),
  }).strict(),
  state: z.object({
    diagnosis: z.enum(["ready", "pending", "unavailable"]),
    baseline: z.enum(["ready", "insufficient", "unavailable"]),
    evidenceDensity: z.enum(["rich", "sparse", "empty"]),
  }).strict(),
}).strict();

export type IncidentDetailExtension = z.infer<typeof IncidentDetailExtensionSchema>;
export type BlastRadiusEntry = z.infer<typeof BlastRadiusEntrySchema>;
export type BlastRadiusRollup = z.infer<typeof BlastRadiusRollupSchema>;
export type ConfidencePrimitives = z.infer<typeof ConfidencePrimitivesSchema>;
export type CorrelationEntry = z.infer<typeof CorrelationEntrySchema>;
