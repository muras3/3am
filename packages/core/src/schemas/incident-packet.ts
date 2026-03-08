import { z } from "zod";

const WindowSchema = z.object({
  start: z.string(),
  detect: z.string(),
  end: z.string(),
});

const ScopeSchema = z.object({
  environment: z.string(),
  primaryService: z.string(),
  affectedServices: z.array(z.string()),
  affectedRoutes: z.array(z.string()),
  affectedDependencies: z.array(z.string()),
});

const TriggerSignalSchema = z.object({
  signal: z.string(),
  firstSeenAt: z.string(),
  entity: z.string(),
});

// Typed shape for representative spans captured at incident time (ADR 0018)
const RepresentativeTraceSchema = z.object({
  traceId: z.string(),
  spanId: z.string(),
  serviceName: z.string(),
  durationMs: z.number(),
  httpStatusCode: z.number().optional(),
  spanStatusCode: z.number(),
});

const EvidenceSchema = z.object({
  changedMetrics: z.array(z.unknown()),   // Phase C: typed when metric ingest is implemented
  representativeTraces: z.array(RepresentativeTraceSchema),
  relevantLogs: z.array(z.unknown()),     // Phase C: typed when log ingest is implemented
  platformEvents: z.array(z.unknown()),   // Phase C: typed when platform-events is implemented
});

const PointersSchema = z.object({
  traceRefs: z.array(z.string()),
  logRefs: z.array(z.string()),
  metricRefs: z.array(z.string()),
  platformLogRefs: z.array(z.string()),
});

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
});

export type IncidentPacket = z.infer<typeof IncidentPacketSchema>;
