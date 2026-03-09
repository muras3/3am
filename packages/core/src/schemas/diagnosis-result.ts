import { z } from "zod";

// All sub-schemas use .strict() so that unknown keys are rejected at every
// nesting level, not just at the top. This prevents callers from accidentally
// embedding incident-packet fields (triggerSignals, evidence, pointers, etc.)
// inside nested objects — a class of mistake that a top-level-only .strict()
// would miss. Mirror of the pattern used in incident-packet.ts.

const CausalChainStepSchema = z.object({
  type: z.enum(["external", "system", "incident", "impact"]),
  title: z.string(),
  detail: z.string(),
}).strict();

const WatchItemSchema = z.object({
  label: z.string(),
  state: z.string(),
  status: z.string(),
}).strict();

export const DiagnosisResultSchema = z.object({
  summary: z.object({
    what_happened: z.string(),
    root_cause_hypothesis: z.string(),
  }).strict(),
  recommendation: z.object({
    immediate_action: z.string(),
    action_rationale_short: z.string(),
    do_not: z.string(),
  }).strict(),
  reasoning: z.object({
    causal_chain: z.array(CausalChainStepSchema),
  }).strict(),
  operator_guidance: z.object({
    watch_items: z.array(WatchItemSchema),
    operator_checks: z.array(z.string()),
  }).strict(),
  confidence: z.object({
    confidence_assessment: z.string(),
    uncertainty: z.string(),
  }).strict(),
  metadata: z.object({
    incident_id: z.string(),
    packet_id: z.string(),
    model: z.string(),
    prompt_version: z.string(),
    created_at: z.string(),
  }).strict(),
}).strict();

export type DiagnosisResult = z.infer<typeof DiagnosisResultSchema>;
export type CausalChainStep = z.infer<typeof CausalChainStepSchema>;
