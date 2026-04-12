import type { Followup } from "./console-narrative.js";

type EvidenceKind = "traces" | "metrics" | "logs";

/**
 * Determines whether a follow-up question can be answered with the
 * currently available evidence surfaces.
 *
 * Pure function — no LLM, no inference. Checks intersection of the
 * question's targetEvidenceKinds with the receiver-provided
 * availableEvidenceKinds.
 */
export function isFollowupAnswerable(
  followup: Pick<Followup, "targetEvidenceKinds">,
  availableEvidenceKinds: readonly EvidenceKind[],
): boolean {
  const available = new Set(availableEvidenceKinds);
  return followup.targetEvidenceKinds.some((kind) => available.has(kind));
}
