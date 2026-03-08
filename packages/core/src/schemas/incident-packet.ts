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

const EvidenceSchema = z.object({
  changedMetrics: z.array(z.unknown()),
  representativeTraces: z.array(z.unknown()),
  relevantLogs: z.array(z.unknown()),
  platformEvents: z.array(z.unknown()),
});

const PointersSchema = z.object({
  traceRefs: z.array(z.unknown()),
  logRefs: z.array(z.unknown()),
  metricRefs: z.array(z.unknown()),
  platformLogRefs: z.array(z.unknown()),
});

export const IncidentPacketSchema = z.object({
  schemaVersion: z.literal("incident-packet/v1alpha1"),
  packetId: z.string(),
  incidentId: z.string(),
  openedAt: z.string(),
  window: WindowSchema,
  scope: ScopeSchema,
  triggerSignals: z.array(TriggerSignalSchema),
  evidence: EvidenceSchema,
  pointers: PointersSchema,
});

export type IncidentPacket = z.infer<typeof IncidentPacketSchema>;
