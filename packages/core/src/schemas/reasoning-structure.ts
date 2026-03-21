import { z } from "zod";

// Evidence reference — deterministic link from proof card to telemetry.
// Receiver produces these; diagnosis and frontend never invent IDs.
const EvidenceRefSchema = z.object({
  kind: z.enum(["span", "log", "metric", "log_cluster", "metric_group"]),
  id: z.string(),
}).strict();

// Proof card reference — receiver-provided, status confirmed by receiver.
const ProofRefSchema = z.object({
  cardId: z.enum(["trigger", "design_gap", "recovery"]),
  targetSurface: z.enum(["traces", "metrics", "logs"]),
  evidenceRefs: z.array(EvidenceRefSchema),
  status: z.enum(["confirmed", "inferred", "pending"]),
}).strict();

// Absence candidate — receiver searched for patterns and reports match count.
const AbsenceCandidateSchema = z.object({
  id: z.string(),
  patterns: z.array(z.string()),
  searchWindow: z.object({
    startMs: z.number(),
    endMs: z.number(),
  }).strict(),
  matchCount: z.number().int().min(0),
}).strict();

// Evidence counts — deterministic tallies from telemetry store.
const EvidenceCountsSchema = z.object({
  traces: z.number().int().min(0),
  traceErrors: z.number().int().min(0),
  metrics: z.number().int().min(0),
  logs: z.number().int().min(0),
  logErrors: z.number().int().min(0),
}).strict();

// Blast radius target — receiver-computed impact per service/route.
const BlastRadiusTargetSchema = z.object({
  targetId: z.string(),
  label: z.string(),
  status: z.enum(["critical", "degraded", "healthy"]),
  impactValue: z.number().min(0).max(1),
  displayValue: z.string(),
}).strict();

// Timeline summary — key timestamps from packet window.
const TimelineSummarySchema = z.object({
  startedAt: z.string(),
  fullCascadeAt: z.string().nullable(),
  diagnosedAt: z.string().nullable(),
}).strict();

// Q&A context — which evidence surfaces have data for answering questions.
const QAContextSchema = z.object({
  availableEvidenceKinds: z.array(z.enum(["traces", "metrics", "logs"])),
}).strict();

/**
 * ReasoningStructure — deterministic context that the receiver provides
 * to stage 2 (console narrative generation). All fields are receiver-computed;
 * diagnosis reads but never modifies this structure.
 */
export const ReasoningStructureSchema = z.object({
  incidentId: z.string(),
  evidenceCounts: EvidenceCountsSchema,
  blastRadius: z.array(BlastRadiusTargetSchema),
  proofRefs: z.array(ProofRefSchema),
  absenceCandidates: z.array(AbsenceCandidateSchema),
  timelineSummary: TimelineSummarySchema,
  qaContext: QAContextSchema,
}).strict();

export type ReasoningStructure = z.infer<typeof ReasoningStructureSchema>;
export type ProofRef = z.infer<typeof ProofRefSchema>;
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export type AbsenceCandidate = z.infer<typeof AbsenceCandidateSchema>;
export type EvidenceCounts = z.infer<typeof EvidenceCountsSchema>;
export type BlastRadiusTarget = z.infer<typeof BlastRadiusTargetSchema>;
export type QAContext = z.infer<typeof QAContextSchema>;
