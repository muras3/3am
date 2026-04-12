import { z } from "zod";

// All sub-schemas use z.strictObject() so that unknown keys are rejected at every
// nesting level, not just at the top. This prevents callers from accidentally
// embedding diagnosis-result fields (immediateAction, rootCauseHypothesis,
// etc.) inside nested objects — a class of mistake that a top-level-only
// strict check would miss.

const WindowSchema = z.strictObject({
  start: z.string(),
  detect: z.string(),
  end: z.string(),
});

const ScopeSchema = z.strictObject({
  environment: z.string(),
  primaryService: z.string(),
  affectedServices: z.array(z.string()),
  affectedRoutes: z.array(z.string()),
  affectedDependencies: z.array(z.string()),
});

const TriggerSignalSchema = z.strictObject({
  signal: z.string(),
  firstSeenAt: z.string(),
  entity: z.string(),
});

// Representative spans captured at incident time (ADR 0018).
// z.strictObject() here ensures no span-level LLM annotations leak into the packet.
export const RepresentativeTraceSchema = z.strictObject({
  traceId: z.string(),
  spanId: z.string(),
  serviceName: z.string(),
  durationMs: z.number(),
  httpStatusCode: z.number().optional(),
  spanStatusCode: z.number(),
});

export type RepresentativeTrace = z.infer<typeof RepresentativeTraceSchema>;

export const PlatformEventSchema = z.strictObject({
  eventType: z.enum(["deploy", "config_change", "provider_incident", "scaling_event"]),
  timestamp: z.string(),
  environment: z.string(),
  description: z.string(),
  service: z.string().optional(),
  deploymentId: z.string().optional(),
  releaseVersion: z.string().optional(),
  provider: z.string().optional(),
  eventId: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type PlatformEvent = z.infer<typeof PlatformEventSchema>;

// Plan 6 / B-4: typed evidence schemas.
// Shapes match evidence-extractor.ts MetricEvidence/LogEvidence exactly.
export const ChangedMetricSchema = z.strictObject({
  name: z.string(),
  service: z.string(),
  environment: z.string(),
  startTimeMs: z.number(),
  summary: z.record(z.string(), z.unknown()),  // histogram/gauge/sum compressed shape — heterogeneous by metric type
});

export type ChangedMetric = z.infer<typeof ChangedMetricSchema>;

export const RelevantLogSchema = z.strictObject({
  service: z.string(),
  environment: z.string(),
  timestamp: z.string(),
  startTimeMs: z.number(),
  severity: z.string(),
  body: z.string(),
  attributes: z.record(z.string(), z.unknown()),
});

export type RelevantLog = z.infer<typeof RelevantLogSchema>;

const EvidenceSchema = z.strictObject({
  changedMetrics: z.array(ChangedMetricSchema),
  representativeTraces: z.array(RepresentativeTraceSchema),
  relevantLogs: z.array(RelevantLogSchema),
  platformEvents: z.array(PlatformEventSchema),
});

const PointersSchema = z.strictObject({
  traceRefs: z.array(z.string()),
  logRefs: z.array(z.string()),
  metricRefs: z.array(z.string()),
  platformLogRefs: z.array(z.string()),
});

// ADR 0018 draws a hard boundary between the incident packet (raw observational
// data: identity / situation / evidence / retrieval) and the diagnosis result
// (LLM output: root cause, immediate action, confidence, etc.).
//
// z.strictObject() enforces this boundary at runtime: any field that belongs to
// DiagnosisResult — immediateAction, rootCauseHypothesis, confidence, doNot,
// whyThisAction — will cause a ZodError if someone tries to embed it here.
// This makes the contract violation detectable early (at ingest / storage time)
// rather than silently corrupting downstream consumers.
export const IncidentPacketSchema = z.strictObject({
  schemaVersion: z.literal("incident-packet/v1alpha1"),
  // identity layer (ADR 0018)
  packetId: z.string(),
  incidentId: z.string(),
  openedAt: z.string(),
  status: z.enum(["open", "closed"]).optional(),
  /** Observed signal severity — deterministically derived from anomalous signals, not business impact. */
  signalSeverity: z.enum(["critical", "high", "medium", "low"]).optional(),
  generation: z.number().optional(),
  window: WindowSchema,
  scope: ScopeSchema,
  // situation layer (ADR 0018)
  triggerSignals: z.array(TriggerSignalSchema),
  // evidence layer (ADR 0018)
  evidence: EvidenceSchema,
  // retrieval layer (ADR 0018)
  pointers: PointersSchema,
});

export type IncidentPacket = z.infer<typeof IncidentPacketSchema>;
