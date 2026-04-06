import { z } from "zod";

// Evidence binding — links a claim in the Q&A answer to concrete evidence.
// Prompt requests ≥1 ref per claim, but smaller models may return empty arrays.
// Accept gracefully to avoid retries that waste LLM budget and block the UI.
export const EvidenceBindingSchema = z.object({
  claim: z.string(),
  evidenceRefs: z.array(z.object({
    kind: z.enum(["span", "log", "metric", "log_cluster", "metric_group"]),
    id: z.string(),
  }).strict()),
}).strict();

// Follow-up question — diagnosis proposes the question and target surfaces.
// Answerability is computed downstream (core pure function), not by diagnosis.
export const FollowupSchema = z.object({
  question: z.string(),
  targetEvidenceKinds: z.array(z.enum(["traces", "metrics", "logs"])).min(1),
}).strict();

// Answer-level evidence ref — flat link from answer to evidence surface.
// Frontend uses this directly without aggregating claim-level bindings.
export const AnswerEvidenceRefSchema = z.object({
  kind: z.enum(["span", "log", "metric", "log_cluster", "metric_group"]),
  id: z.string(),
}).strict();

// QA Narrative — pre-generated question/answer with both answer-level
// and claim-level evidence refs. Frontend uses answerEvidenceRefs directly;
// evidenceBindings provide granular claim→evidence mapping for drill-down.
export const QANarrativeSchema = z.object({
  question: z.string(),
  answer: z.string(),
  answerEvidenceRefs: z.array(AnswerEvidenceRefSchema),
  evidenceBindings: z.array(EvidenceBindingSchema),
  followups: z.array(FollowupSchema),
  noAnswerReason: z.string().nullable(),
}).strict();

// Proof card narrative — wording only. Status comes from ProofRef (receiver).
export const ProofCardNarrativeSchema = z.object({
  id: z.enum(["trigger", "design_gap", "recovery"]),
  label: z.string(),
  summary: z.string(),
}).strict();

// Confidence summary — wording extraction only. No label or numeric value.
export const NarrativeConfidenceSummarySchema = z.object({
  basis: z.string(),
  risk: z.string(),
}).strict();

// Side note — right-rail context for Evidence Studio.
export const NarrativeSideNoteSchema = z.object({
  title: z.string(),
  text: z.string(),
  kind: z.enum(["confidence", "uncertainty", "dependency"]),
}).strict();

// Absence evidence — narrative labels for receiver-detected absences.
export const NarrativeAbsenceEvidenceSchema = z.object({
  id: z.string(),
  label: z.string(),
  expected: z.string(),
  observed: z.string(),
  explanation: z.string(),
}).strict();

// Metadata — provenance for the narrative generation.
export const NarrativeMetadataSchema = z.object({
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
  headline: z.string(),
  whyThisAction: z.string(),
  confidenceSummary: NarrativeConfidenceSummarySchema,
  proofCards: z.array(ProofCardNarrativeSchema).length(3),
  qa: QANarrativeSchema,
  sideNotes: z.array(NarrativeSideNoteSchema),
  absenceEvidence: z.array(NarrativeAbsenceEvidenceSchema),
  metadata: NarrativeMetadataSchema,
}).strict();

export type ConsoleNarrative = z.infer<typeof ConsoleNarrativeSchema>;
export type QANarrative = z.infer<typeof QANarrativeSchema>;
export type ProofCardNarrative = z.infer<typeof ProofCardNarrativeSchema>;
export type NarrativeConfidenceSummary = z.infer<typeof NarrativeConfidenceSummarySchema>;
export type NarrativeSideNote = z.infer<typeof NarrativeSideNoteSchema>;
export type AbsenceEvidence = z.infer<typeof NarrativeAbsenceEvidenceSchema>;
export type EvidenceBinding = z.infer<typeof EvidenceBindingSchema>;
export type Followup = z.infer<typeof FollowupSchema>;
