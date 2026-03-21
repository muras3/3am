import { z } from "zod";
import { CuratedStateSchema } from "./runtime-map.js";

const CorrelationEntrySchema = z.object({
  metricName: z.string(),
  service: z.string(),
  correlationValue: z.number(),
  pValue: z.number().optional(),
}).strict();

export const ConfidencePrimitivesSchema = z.object({
  evidenceCoverage: z.object({
    traceCount: z.number(),
    metricCount: z.number(),
    logCount: z.number(),
    baselineSampleCount: z.number(),
  }).strict(),
  correlations: z.array(CorrelationEntrySchema),
  baselineConfidence: z.enum(["high", "medium", "low", "unavailable"]),
}).strict();

export const InternalBlastRadiusEntrySchema = z.object({
  targetId: z.string(),
  label: z.string(),
  status: z.enum(["healthy", "degraded", "critical"]),
  impactMetric: z.literal("error_rate"),
  impactValue: z.number(),
  displayValue: z.string(),
}).strict();

export const BlastRadiusRollupSchema = z.object({
  healthyCount: z.number(),
  label: z.string(),
}).strict();

export const IncidentDetailExtensionSchema = z.object({
  impactSummary: z.object({
    startedAt: z.string(),
    fullCascadeAt: z.string().optional(),
    diagnosedAt: z.string().optional(),
  }).strict(),
  blastRadius: z.array(InternalBlastRadiusEntrySchema),
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
  state: CuratedStateSchema,
}).strict();

export const IncidentChipSchema = z.object({
  type: z.enum(["critical", "system", "external"]),
  label: z.string(),
}).strict();

export const IncidentActionSchema = z.object({
  text: z.string(),
  rationale: z.string(),
  doNot: z.string(),
}).strict();

export const CausalStepSchema = z.object({
  type: z.enum(["external", "system", "incident", "impact"]),
  tag: z.string(),
  title: z.string(),
  detail: z.string(),
}).strict();

export const ImpactSummarySchema = z.object({
  startedAt: z.string(),
  fullCascadeAt: z.string(),
  diagnosedAt: z.string(),
}).strict();

export const BlastRadiusEntrySchema = z.object({
  target: z.string(),
  status: z.enum(["healthy", "degraded", "critical"]),
  impactValue: z.number(),
  label: z.string(),
}).strict();

export const ConfidenceSummarySchema = z.object({
  label: z.string(),
  value: z.number(),
  basis: z.string(),
  risk: z.string(),
}).strict();

export const EvidenceCountsSchema = z.object({
  traces: z.number(),
  traceErrors: z.number(),
  metrics: z.number(),
  logs: z.number(),
  logErrors: z.number(),
}).strict();

export const ExtendedIncidentSchema = z.object({
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
}).strict();

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
