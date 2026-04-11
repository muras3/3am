import { z } from "zod";
import { CuratedStateSchema } from "./runtime-map.js";

const CorrelationEntrySchema = z.strictObject({
  metricName: z.string(),
  service: z.string(),
  correlationValue: z.number(),
  pValue: z.number().optional(),
});

export const ConfidencePrimitivesSchema = z.strictObject({
  evidenceCoverage: z.strictObject({
    traceCount: z.number(),
    metricCount: z.number(),
    logCount: z.number(),
    baselineSampleCount: z.number(),
  }),
  correlations: z.array(CorrelationEntrySchema),
  baselineConfidence: z.enum(["high", "medium", "low", "unavailable"]),
});

export const InternalBlastRadiusEntrySchema = z.strictObject({
  targetId: z.string(),
  label: z.string(),
  status: z.enum(["healthy", "degraded", "critical"]),
  impactMetric: z.literal("error_rate"),
  impactValue: z.number(),
  displayValue: z.string(),
});

export const BlastRadiusRollupSchema = z.strictObject({
  healthyCount: z.number(),
  label: z.string(),
});

export const IncidentDetailExtensionSchema = z.strictObject({
  impactSummary: z.strictObject({
    startedAt: z.string(),
    fullCascadeAt: z.string().optional(),
    diagnosedAt: z.string().optional(),
  }),
  blastRadius: z.array(InternalBlastRadiusEntrySchema),
  blastRadiusRollup: BlastRadiusRollupSchema,
  confidencePrimitives: ConfidencePrimitivesSchema,
  evidenceSummary: z.strictObject({
    traces: z.number(),
    traceErrors: z.number(),
    metrics: z.number(),
    metricsAnomalous: z.number(),
    logs: z.number(),
    logErrors: z.number(),
  }),
  state: CuratedStateSchema,
});

export const IncidentChipSchema = z.strictObject({
  type: z.enum(["critical", "system", "external"]),
  label: z.string(),
});

export const IncidentActionSchema = z.strictObject({
  text: z.string(),
  rationale: z.string(),
  doNot: z.string(),
});

export const CausalStepSchema = z.strictObject({
  type: z.enum(["external", "system", "incident", "impact"]),
  tag: z.string(),
  title: z.string(),
  detail: z.string(),
});

export const ImpactSummarySchema = z.strictObject({
  startedAt: z.string(),
  fullCascadeAt: z.string(),
  diagnosedAt: z.string(),
});

export const BlastRadiusEntrySchema = z.strictObject({
  target: z.string(),
  status: z.enum(["healthy", "degraded", "critical"]),
  impactValue: z.number(),
  label: z.string(),
});

export const ConfidenceSummarySchema = z.strictObject({
  label: z.string(),
  value: z.number(),
  basis: z.string(),
  risk: z.string(),
});

export const EvidenceCountsSchema = z.strictObject({
  traces: z.number(),
  traceErrors: z.number(),
  metrics: z.number(),
  logs: z.number(),
  logErrors: z.number(),
});

export const ExtendedIncidentSchema = z.strictObject({
  incidentId: z.string(),
  status: z.enum(["open", "closed"]),
  severity: z.string(),
  openedAt: z.string(),
  closedAt: z.string().optional(),
  headline: z.string(),
  chips: z.array(IncidentChipSchema),
  action: IncidentActionSchema,
  rootCauseHypothesis: z.string(),
  causalChain: z.array(CausalStepSchema),
  operatorChecks: z.array(z.string()),
  impactSummary: ImpactSummarySchema,
  blastRadius: z.array(BlastRadiusEntrySchema),
  confidenceSummary: ConfidenceSummarySchema,
  evidenceSummary: EvidenceCountsSchema,
  state: CuratedStateSchema,
});

export type IncidentDetailExtension = z.infer<typeof IncidentDetailExtensionSchema>;
export type InternalBlastRadiusEntry = z.infer<typeof InternalBlastRadiusEntrySchema>;
export type BlastRadiusRollup = z.infer<typeof BlastRadiusRollupSchema>;
export type ConfidencePrimitives = z.infer<typeof ConfidencePrimitivesSchema>;
export type CorrelationEntry = z.infer<typeof CorrelationEntrySchema>;
export type IncidentChip = z.infer<typeof IncidentChipSchema>;
export type IncidentAction = z.infer<typeof IncidentActionSchema>;
export type CausalStep = z.infer<typeof CausalStepSchema>;
export type ImpactSummary = z.infer<typeof ImpactSummarySchema>;
export type BlastRadiusEntry = z.infer<typeof BlastRadiusEntrySchema>;
export type ConfidenceSummary = z.infer<typeof ConfidenceSummarySchema>;
export type EvidenceCounts = z.infer<typeof EvidenceCountsSchema>;
export type ExtendedIncident = z.infer<typeof ExtendedIncidentSchema>;
