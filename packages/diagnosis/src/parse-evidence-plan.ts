export type EvidencePlanMode = "answer" | "action" | "missing_evidence" | "clarification";

export type EvidencePlan = {
  mode: EvidencePlanMode;
  rewrittenQuestion: string;
  preferredSurfaces: Array<"traces" | "metrics" | "logs">;
  clarificationQuestion?: string;
};

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const match = /```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(raw);
    if (match?.[1] !== undefined) {
      return JSON.parse(match[1]);
    }
    throw new Error("Failed to parse evidence plan output as JSON");
  }
}

function isSurface(value: string): value is "traces" | "metrics" | "logs" {
  return value === "traces" || value === "metrics" || value === "logs";
}

export function parseEvidencePlan(raw: string): EvidencePlan {
  const parsed = parseJson(raw) as Record<string, unknown>;
  const mode = parsed["mode"];
  const rewrittenQuestion = parsed["rewrittenQuestion"];
  const preferredSurfaces = parsed["preferredSurfaces"];
  const clarificationQuestion = parsed["clarificationQuestion"];

  if (mode !== "answer" && mode !== "action" && mode !== "missing_evidence" && mode !== "clarification") {
    throw new Error("EvidencePlanValidationError: invalid mode.");
  }
  if (typeof rewrittenQuestion !== "string" || rewrittenQuestion.trim().length === 0) {
    throw new Error("EvidencePlanValidationError: rewrittenQuestion is required.");
  }
  if (!Array.isArray(preferredSurfaces) || preferredSurfaces.length === 0 || preferredSurfaces.some((s) => typeof s !== "string" || !isSurface(s))) {
    throw new Error("EvidencePlanValidationError: preferredSurfaces must be a non-empty array of valid surfaces.");
  }
  if (mode === "clarification" && (typeof clarificationQuestion !== "string" || clarificationQuestion.trim().length === 0)) {
    throw new Error("EvidencePlanValidationError: clarificationQuestion is required for clarification mode.");
  }

  return {
    mode,
    rewrittenQuestion: rewrittenQuestion.trim(),
    preferredSurfaces: preferredSurfaces as Array<"traces" | "metrics" | "logs">,
    clarificationQuestion: typeof clarificationQuestion === "string" ? clarificationQuestion.trim() : undefined,
  };
}
