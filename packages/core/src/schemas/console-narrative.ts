import { z } from "zod";

// Evidence binding — links a claim in the Q&A answer to concrete evidence.
// Each binding must have ≥1 concrete ref (span|log|metric|log_cluster|metric_group).
const EvidenceBindingSchema = z.object({
  claim: z.string(),
  evidenceRefs: z.array(z.object({
    kind: z.enum(["span", "log", "metric", "log_cluster", "metric_group"]),
    id: z.string(),
  }).strict()).min(1),
}).strict();

// Follow-up question — diagnosis proposes the question and target surfaces.
// Answerability is computed downstream (core pure function), not by diagnosis.
const FollowupSchema = z.object({
  question: z.string(),
  targetEvidenceKinds: z.array(z.enum(["traces", "metrics", "logs"])).min(1),
}).strict();

// Answer-level evidence ref — flat link from answer to evidence surface.
// Frontend uses this directly without aggregating claim-level bindings.
const AnswerEvidenceRefSchema = z.object({
  kind: z.enum(["span", "log", "metric", "log_cluster", "metric_group"]),
  id: z.string(),
}).strict();

// QA Narrative — pre-generated question/answer with both answer-level
// and claim-level evidence refs. Frontend uses answerEvidenceRefs directly;
// evidenceBindings provide granular claim→evidence mapping for drill-down.
const QANarrativeSchema = z.object({
  question: z.string(),
  answer: z.string(),
  answerEvidenceRefs: z.array(AnswerEvidenceRefSchema),
  evidenceBindings: z.array(EvidenceBindingSchema),
  followups: z.array(FollowupSchema),
  noAnswerReason: z.string().nullable(),
}).strict();

// Proof card narrative — wording only. Status comes from ProofRef (receiver).
const ProofCardNarrativeSchema = z.object({
  id: z.enum(["trigger", "design_gap", "recovery"]),
  label: z.string(),
  summary: z.string(),
}).strict();

// Confidence summary — wording extraction only. No label or numeric value.
const ConfidenceSummarySchema = z.object({
  basis: z.string(),
  risk: z.string(),
}).strict();

// Side note — right-rail context for Evidence Studio.
const SideNoteSchema = z.object({
  title: z.string(),
  text: z.string(),
  kind: z.enum(["confidence", "uncertainty", "dependency"]),
}).strict();

// Absence evidence — narrative labels for receiver-detected absences.
const AbsenceEvidenceSchema = z.object({
  id: z.string(),
  label: z.string(),
  expected: z.string(),
  observed: z.string(),
  explanation: z.string(),
}).strict();

// Metadata — provenance for the narrative generation.
const NarrativeMetadataSchema = z.object({
  model: z.string(),
  prompt_version: z.string(),
  created_at: z.string(),
  stage1_packet_id: z.string(),
}).strict();

/**
 * ConsoleNarrative — stage 2 output. Contains only wording/narrative;
 * all judgments, classifications, and numeric values come from
 * DiagnosisResult (stage 1) or ReasoningStructure (receiver).
 */
export const ConsoleNarrativeSchema = z.object({
  headline: z.string().max(120),
  whyThisAction: z.string(),
  confidenceSummary: ConfidenceSummarySchema,
  proofCards: z.array(ProofCardNarrativeSchema).length(3),
  qa: QANarrativeSchema,
  sideNotes: z.array(SideNoteSchema),
  absenceEvidence: z.array(AbsenceEvidenceSchema),
  metadata: NarrativeMetadataSchema,
}).strict();

export type ConsoleNarrative = z.infer<typeof ConsoleNarrativeSchema>;
export type QANarrative = z.infer<typeof QANarrativeSchema>;
export type ProofCardNarrative = z.infer<typeof ProofCardNarrativeSchema>;
export type ConfidenceSummary = z.infer<typeof ConfidenceSummarySchema>;
export type SideNote = z.infer<typeof SideNoteSchema>;
export type AbsenceEvidence = z.infer<typeof AbsenceEvidenceSchema>;
export type EvidenceBinding = z.infer<typeof EvidenceBindingSchema>;
export type Followup = z.infer<typeof FollowupSchema>;
