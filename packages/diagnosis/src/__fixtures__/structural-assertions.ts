/**
 * Structural assertions for ConsoleNarrative output validation.
 * Not exact-match — checks structural correctness, constraint adherence,
 * and forbidden patterns.
 */
import { ConsoleNarrativeSchema } from "@3amoncall/core";
import type { ConsoleNarrative, ReasoningStructure } from "@3amoncall/core";

export interface AssertionResult {
  pass: boolean;
  failures: string[];
}

/**
 * Run all structural assertions on a ConsoleNarrative output.
 * Returns pass/fail with list of failures.
 */
export function assertConsoleNarrative(
  narrative: unknown,
  context: ReasoningStructure,
): AssertionResult {
  const failures: string[] = [];

  // 1. Schema parse
  const parseResult = ConsoleNarrativeSchema.safeParse(narrative);
  if (!parseResult.success) {
    failures.push(`Schema parse failed: ${parseResult.error.message}`);
    return { pass: false, failures };
  }
  const n = parseResult.data;

  // 2. Required fields non-empty
  if (!n.headline.trim()) failures.push("headline is empty");
  if (!n.whyThisAction.trim()) failures.push("whyThisAction is empty");
  if (!n.confidenceSummary.basis.trim()) failures.push("confidenceSummary.basis is empty");
  if (!n.confidenceSummary.risk.trim()) failures.push("confidenceSummary.risk is empty");

  // 3. Proof cards: all 3 present with non-empty label and summary
  const cardIds = n.proofCards.map((c) => c.id);
  if (!cardIds.includes("trigger")) failures.push("Missing trigger proof card");
  if (!cardIds.includes("design_gap")) failures.push("Missing design_gap proof card");
  if (!cardIds.includes("recovery")) failures.push("Missing recovery proof card");
  for (const card of n.proofCards) {
    if (!card.label.trim()) failures.push(`proofCard ${card.id}: empty label`);
    if (!card.summary.trim()) failures.push(`proofCard ${card.id}: empty summary`);
  }

  // 4. Pending proof cards should mention evidence unavailability
  for (const ref of context.proofRefs) {
    if (ref.status === "pending") {
      const card = n.proofCards.find((c) => c.id === ref.cardId);
      if (card && !looksLikePendingSummary(card.summary)) {
        failures.push(`proofCard ${ref.cardId}: status is pending but summary doesn't indicate evidence unavailability`);
      }
    }
  }

  // 5. Evidence bindings: concrete ref constraint
  for (const binding of n.qa.evidenceBindings) {
    if (!binding.claim.trim()) {
      failures.push("evidenceBinding has empty claim");
    }
    // Each binding must have concrete refs (enforced by schema min(1), but double-check)
    if (binding.evidenceRefs.length === 0) {
      failures.push(`evidenceBinding "${binding.claim}": no evidence refs`);
    }
  }

  // 6. Evidence refs must only reference IDs from proofRefs
  const knownIds = new Set<string>();
  for (const ref of context.proofRefs) {
    for (const er of ref.evidenceRefs) {
      knownIds.add(er.id);
    }
  }
  for (const binding of n.qa.evidenceBindings) {
    for (const ref of binding.evidenceRefs) {
      if (!knownIds.has(ref.id)) {
        failures.push(`evidenceBinding ref "${ref.id}" not found in proofRefs`);
      }
    }
  }

  // 7. Headline length
  if (n.headline.length > 120) {
    failures.push(`headline exceeds 120 chars: ${n.headline.length}`);
  }

  // 8. Q&A answer non-empty when noAnswerReason is null
  if (n.qa.noAnswerReason === null && !n.qa.answer.trim()) {
    failures.push("Q&A answer is empty but noAnswerReason is null");
  }

  // 9. Unanswerable case: evidenceBindings should be empty
  if (n.qa.noAnswerReason !== null && n.qa.evidenceBindings.length > 0) {
    failures.push("noAnswerReason is set but evidenceBindings is non-empty");
  }

  return { pass: failures.length === 0, failures };
}

function looksLikePendingSummary(summary: string): boolean {
  const lower = summary.toLowerCase();
  return (
    lower.includes("not yet available") ||
    lower.includes("pending") ||
    lower.includes("insufficient") ||
    lower.includes("no evidence") ||
    lower.includes("unavailable") ||
    lower.includes("not available")
  );
}
