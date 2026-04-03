import {
  ConsoleNarrativeSchema,
  type ConsoleNarrative,
  type ReasoningStructure,
} from "@3am/core";

export type NarrativeMeta = {
  model: string;
  promptVersion: string;
  stage1PacketId: string;
};

const MAX_STRING = 2000;
const MAX_BINDINGS = 10;
const MAX_FOLLOWUPS = 8;
const MAX_ABSENCE = 10;
const MAX_SIDENOTES = 6;

function checkStr(path: string, value: string, max: number): void {
  if (value.length > max) {
    throw new Error(
      `NarrativeOutputSizeError: ${path} is ${value.length} chars (max ${max})`,
    );
  }
}

/**
 * Validates that all evidence ref IDs in evidenceBindings exist in the
 * proofRefs provided by the receiver. Rejects invented IDs.
 */
function validateEvidenceRefIds(
  narrative: ConsoleNarrative,
  context: ReasoningStructure,
): void {
  const knownIds = new Set<string>();
  for (const ref of context.proofRefs) {
    for (const er of ref.evidenceRefs) {
      knownIds.add(er.id);
    }
  }

  for (const ref of narrative.qa.answerEvidenceRefs) {
    if (!knownIds.has(ref.id)) {
      throw new Error(
        `NarrativeValidationError: answerEvidenceRef "${ref.id}" is not in proofRefs. Diagnosis must not invent IDs.`,
      );
    }
  }

  for (const binding of narrative.qa.evidenceBindings) {
    for (const ref of binding.evidenceRefs) {
      if (!knownIds.has(ref.id)) {
        throw new Error(
          `NarrativeValidationError: evidence ref "${ref.id}" is not in proofRefs. Diagnosis must not invent IDs.`,
        );
      }
    }
  }
}

function normalizeEvidenceRefIds(narrative: ConsoleNarrative): ConsoleNarrative {
  const normalizeId = (kind: string, id: string): string => {
    const prefix = `${kind}:`;
    return id.startsWith(prefix) ? id.slice(prefix.length) : id;
  };

  return {
    ...narrative,
    qa: {
      ...narrative.qa,
      answerEvidenceRefs: narrative.qa.answerEvidenceRefs.map((ref) => ({
        ...ref,
        id: normalizeId(ref.kind, ref.id),
      })),
      evidenceBindings: narrative.qa.evidenceBindings.map((binding) => ({
        ...binding,
        evidenceRefs: binding.evidenceRefs.map((ref) => ({
          ...ref,
          id: normalizeId(ref.kind, ref.id),
        })),
      })),
    },
  };
}

function validateOutputSize(narrative: ConsoleNarrative): void {
  checkStr("whyThisAction", narrative.whyThisAction, MAX_STRING);
  checkStr("confidenceSummary.basis", narrative.confidenceSummary.basis, MAX_STRING);
  checkStr("confidenceSummary.risk", narrative.confidenceSummary.risk, MAX_STRING);

  for (const card of narrative.proofCards) {
    checkStr(`proofCard[${card.id}].label`, card.label, MAX_STRING);
    checkStr(`proofCard[${card.id}].summary`, card.summary, MAX_STRING);
  }

  checkStr("qa.question", narrative.qa.question, MAX_STRING);
  checkStr("qa.answer", narrative.qa.answer, MAX_STRING);
  if (narrative.qa.noAnswerReason) {
    checkStr("qa.noAnswerReason", narrative.qa.noAnswerReason, MAX_STRING);
  }

  if (narrative.qa.evidenceBindings.length > MAX_BINDINGS) {
    throw new Error(
      `NarrativeOutputSizeError: evidenceBindings has ${narrative.qa.evidenceBindings.length} items (max ${MAX_BINDINGS})`,
    );
  }

  if (narrative.qa.followups.length > MAX_FOLLOWUPS) {
    throw new Error(
      `NarrativeOutputSizeError: followups has ${narrative.qa.followups.length} items (max ${MAX_FOLLOWUPS})`,
    );
  }

  if (narrative.absenceEvidence.length > MAX_ABSENCE) {
    throw new Error(
      `NarrativeOutputSizeError: absenceEvidence has ${narrative.absenceEvidence.length} items (max ${MAX_ABSENCE})`,
    );
  }

  if (narrative.sideNotes.length > MAX_SIDENOTES) {
    throw new Error(
      `NarrativeOutputSizeError: sideNotes has ${narrative.sideNotes.length} items (max ${MAX_SIDENOTES})`,
    );
  }

  for (const binding of narrative.qa.evidenceBindings) {
    checkStr(`evidenceBinding.claim`, binding.claim, MAX_STRING);
  }

  for (const note of narrative.sideNotes) {
    checkStr(`sideNote[${note.title}].text`, note.text, MAX_STRING);
  }

  for (const abs of narrative.absenceEvidence) {
    checkStr(`absenceEvidence[${abs.id}].label`, abs.label, MAX_STRING);
    checkStr(`absenceEvidence[${abs.id}].expected`, abs.expected, MAX_STRING);
    checkStr(`absenceEvidence[${abs.id}].observed`, abs.observed, MAX_STRING);
    checkStr(`absenceEvidence[${abs.id}].explanation`, abs.explanation, MAX_STRING);
  }
}

export function parseNarrative(
  raw: string,
  meta: NarrativeMeta,
  context: ReasoningStructure,
): ConsoleNarrative {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = /```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(raw);
    if (match?.[1] !== undefined) {
      try {
        parsed = JSON.parse(match[1]);
      } catch {
        throw new Error("Failed to parse narrative output as JSON");
      }
    } else {
      throw new Error("Failed to parse narrative output as JSON");
    }
  }

  const withMeta = {
    ...(parsed as Record<string, unknown>),
    metadata: {
      model: meta.model,
      prompt_version: meta.promptVersion,
      created_at: new Date().toISOString(),
      stage1_packet_id: meta.stage1PacketId,
    },
  };

  const result = normalizeEvidenceRefIds(ConsoleNarrativeSchema.parse(withMeta));
  validateOutputSize(result);
  validateEvidenceRefIds(result, context);

  return result;
}
