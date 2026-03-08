import { z } from "zod";

// All sub-schemas use .strict() so that unknown keys are rejected at every
// nesting level, not just at the top. This prevents callers from accidentally
// embedding diagnosis-result fields (immediateAction, rootCauseHypothesis,
// etc.) inside nested objects — a class of mistake that a top-level-only
// .strict() would miss.

const WindowSchema = z.object({
  start: z.string(),
  detect: z.string(),
  end: z.string(),
}).strict();

const ScopeSchema = z.object({
  environment: z.string(),
  primaryService: z.string(),
  affectedServices: z.array(z.string()),
  affectedRoutes: z.array(z.string()),
  affectedDependencies: z.array(z.string()),
}).strict();

const TriggerSignalSchema = z.object({
  signal: z.string(),
  firstSeenAt: z.string(),
  entity: z.string(),
}).strict();

// Representative spans captured at incident time (ADR 0018).
// .strict() here ensures no span-level LLM annotations leak into the packet.
const RepresentativeTraceSchema = z.object({
  traceId: z.string(),
  spanId: z.string(),
  serviceName: z.string(),
  durationMs: z.number(),
  httpStatusCode: z.number().optional(),
  spanStatusCode: z.number(),
}).strict();

const EvidenceSchema = z.object({
  changedMetrics: z.array(z.unknown()),   // Phase C: typed when metric ingest is implemented
  representativeTraces: z.array(RepresentativeTraceSchema),
  relevantLogs: z.array(z.unknown()),     // Phase C: typed when log ingest is implemented
  platformEvents: z.array(z.unknown()),   // Phase C: typed when platform-events is implemented
}).strict();

const PointersSchema = z.object({
  traceRefs: z.array(z.string()),
  logRefs: z.array(z.string()),
  metricRefs: z.array(z.string()),
  platformLogRefs: z.array(z.string()),
}).strict();

// ADR 0018 draws a hard boundary between the incident packet (raw observational
// data: identity / situation / evidence / retrieval) and the diagnosis result
// (LLM output: root cause, immediate action, confidence, etc.).
//
// .strict() enforces this boundary at runtime: any field that belongs to
// DiagnosisResult — immediateAction, rootCauseHypothesis, confidence, doNot,
// whyThisAction — will cause a ZodError if someone tries to embed it here.
// This makes the contract violation detectable early (at ingest / storage time)
// rather than silently corrupting downstream consumers.
export const IncidentPacketSchema = z.object({
  schemaVersion: z.literal("incident-packet/v1alpha1"),
  // identity layer (ADR 0018)
  packetId: z.string(),
  incidentId: z.string(),
  openedAt: z.string(),
  status: z.enum(["open", "closed"]).optional(),
  severity: z.string().optional(),
  window: WindowSchema,
  scope: ScopeSchema,
  // situation layer (ADR 0018)
  triggerSignals: z.array(TriggerSignalSchema),
  // evidence layer (ADR 0018)
  evidence: EvidenceSchema,
  // retrieval layer (ADR 0018)
  pointers: PointersSchema,
}).strict();

export type IncidentPacket = z.infer<typeof IncidentPacketSchema>;
