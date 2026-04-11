import { z } from "zod";

// Evidence reference — deterministic link from proof card to telemetry.
// Receiver produces these; diagnosis and frontend never invent IDs.
export const NarrativeEvidenceRefSchema = z.strictObject({
  kind: z.enum(["span", "log", "metric", "log_cluster", "metric_group"]),
  id: z.string(),
});

// Proof card reference — receiver-provided, status confirmed by receiver.
export const ProofRefSchema = z.strictObject({
  cardId: z.enum(["trigger", "design_gap", "recovery"]),
  targetSurface: z.enum(["traces", "metrics", "logs"]),
  evidenceRefs: z.array(NarrativeEvidenceRefSchema),
  status: z.enum(["confirmed", "inferred", "pending"]),
});

// Absence candidate — receiver searched for patterns and reports match count.
export const AbsenceCandidateSchema = z.strictObject({
  id: z.string(),
  patterns: z.array(z.string()),
  searchWindow: z.strictObject({
    startMs: z.number(),
    endMs: z.number(),
  }),
  matchCount: z.number().int().min(0),
});

// Evidence counts — deterministic tallies from telemetry store.
export const NarrativeEvidenceCountsSchema = z.strictObject({
  traces: z.number().int().min(0),
  traceErrors: z.number().int().min(0),
  metrics: z.number().int().min(0),
  logs: z.number().int().min(0),
  logErrors: z.number().int().min(0),
});

// Blast radius target — receiver-computed impact per service/route.
export const BlastRadiusTargetSchema = z.strictObject({
  targetId: z.string(),
  label: z.string(),
  status: z.enum(["critical", "degraded", "healthy"]),
  impactValue: z.number().min(0).max(1),
  displayValue: z.string(),
});

// Timeline summary — key timestamps from packet window.
export const TimelineSummarySchema = z.strictObject({
  startedAt: z.string(),
  fullCascadeAt: z.string().nullable(),
  diagnosedAt: z.string().nullable(),
});

// Q&A context — which evidence surfaces have data for answering questions.
export const QAContextSchema = z.strictObject({
  availableEvidenceKinds: z.array(z.enum(["traces", "metrics", "logs"])),
});

/**
 * ReasoningStructure — deterministic context that the receiver provides
 * to stage 2 (console narrative generation). All fields are receiver-computed;
 * diagnosis reads but never modifies this structure.
 */
export const ReasoningStructureSchema = z.strictObject({
  incidentId: z.string(),
  evidenceCounts: NarrativeEvidenceCountsSchema,
  blastRadius: z.array(BlastRadiusTargetSchema),
  proofRefs: z.array(ProofRefSchema),
  absenceCandidates: z.array(AbsenceCandidateSchema),
  timelineSummary: TimelineSummarySchema,
  qaContext: QAContextSchema,
});

export type ReasoningStructure = z.infer<typeof ReasoningStructureSchema>;
export type ProofRef = z.infer<typeof ProofRefSchema>;
export type NarrativeEvidenceRef = z.infer<typeof NarrativeEvidenceRefSchema>;
export type AbsenceCandidate = z.infer<typeof AbsenceCandidateSchema>;
export type NarrativeEvidenceCounts = z.infer<typeof NarrativeEvidenceCountsSchema>;
export type BlastRadiusTarget = z.infer<typeof BlastRadiusTargetSchema>;
export type QAContext = z.infer<typeof QAContextSchema>;
