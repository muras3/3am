import { z } from "zod";

// All sub-schemas use z.strictObject() so that unknown keys are rejected at every
// nesting level, not just at the top. This prevents callers from accidentally
// embedding incident-packet fields (triggerSignals, evidence, pointers, etc.)
// inside nested objects — a class of mistake that a top-level-only strict
// check would miss. Mirror of the pattern used in incident-packet.ts.

const CausalChainStepSchema = z.strictObject({
  type: z.enum(["external", "system", "incident", "impact"]),
  title: z.string(),
  detail: z.string(),
});

const WatchItemSchema = z.strictObject({
  label: z.string(),
  state: z.string(),
  status: z.string(),
});

export const DiagnosisResultSchema = z.strictObject({
  summary: z.strictObject({
    what_happened: z.string(),
    root_cause_hypothesis: z.string(),
  }),
  recommendation: z.strictObject({
    immediate_action: z.string(),
    action_rationale_short: z.string(),
    do_not: z.string(),
  }),
  reasoning: z.strictObject({
    causal_chain: z.array(CausalChainStepSchema),
  }),
  operator_guidance: z.strictObject({
    watch_items: z.array(WatchItemSchema),
    operator_checks: z.array(z.string()),
  }),
  confidence: z.strictObject({
    confidence_assessment: z.string(),
    uncertainty: z.string(),
  }),
  metadata: z.strictObject({
    incident_id: z.string(),
    packet_id: z.string(),
    model: z.string(),
    prompt_version: z.string(),
    created_at: z.string(),
  }),
});

export type DiagnosisResult = z.infer<typeof DiagnosisResultSchema>;
export type CausalChainStep = z.infer<typeof CausalChainStepSchema>;
