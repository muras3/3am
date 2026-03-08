import { z } from "zod";

const CausalChainStepSchema = z.object({
  type: z.enum(["external", "system", "incident", "impact"]),
  title: z.string(),
  detail: z.string(),
});

const WatchItemSchema = z.object({
  label: z.string(),
  state: z.string(),
  status: z.string(),
});

export const DiagnosisResultSchema = z.object({
  summary: z.object({
    what_happened: z.string(),
    root_cause_hypothesis: z.string(),
  }),
  recommendation: z.object({
    immediate_action: z.string(),
    action_rationale_short: z.string(),
    do_not: z.string(),
  }),
  reasoning: z.object({
    causal_chain: z.array(CausalChainStepSchema),
  }),
  operator_guidance: z.object({
    watch_items: z.array(WatchItemSchema),
    operator_checks: z.array(z.string()),
  }),
  confidence: z.object({
    confidence_assessment: z.string(),
    uncertainty: z.string(),
  }),
  metadata: z.object({
    incident_id: z.string(),
    packet_id: z.string(),
    model: z.string(),
    prompt_version: z.string(),
    created_at: z.string(),
  }),
});

export type DiagnosisResult = z.infer<typeof DiagnosisResultSchema>;
export type CausalChainStep = z.infer<typeof CausalChainStepSchema>;
