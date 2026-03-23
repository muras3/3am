import type { CuratedState } from "../../../api/curated-types.js";

type Section =
  | "headline"
  | "action"
  | "rootCause"
  | "blastRadius"
  | "confidence"
  | "checks"
  | "chain"
  | "evidence";

export function describeBoardState(state: CuratedState): string {
  if (state.diagnosis === "pending") return "Diagnosis pending.";
  if (state.diagnosis === "unavailable") return "Diagnosis unavailable.";
  if (state.evidenceDensity === "empty") return "No supporting evidence returned.";
  if (state.evidenceDensity === "sparse") return "Sparse evidence returned.";
  if (state.baseline === "insufficient") return "Baseline is insufficient.";
  if (state.baseline === "unavailable") return "Baseline is unavailable.";
  return "No data returned.";
}

export function sectionFallback(state: CuratedState, section: Section): string {
  if (state.diagnosis === "pending") {
    switch (section) {
      case "headline":
        return "Diagnosis pending for this incident.";
      case "action":
        return "Immediate action will populate when diagnosis is ready.";
      case "rootCause":
        return "Root cause hypothesis will populate when diagnosis completes.";
      case "blastRadius":
        return "Blast radius details are waiting for diagnosis output.";
      case "confidence":
        return "Confidence summary will populate when diagnosis completes.";
      case "checks":
        return "Operator checks will populate when diagnosis completes.";
      case "chain":
        return "Causal chain will populate when diagnosis completes.";
      case "evidence":
        return "Evidence timings and counts are still being assembled.";
    }
  }

  if (state.diagnosis === "unavailable") {
    switch (section) {
      case "headline":
        return "Diagnosis is unavailable for this incident.";
      case "action":
        return "Immediate action is unavailable for this incident.";
      case "rootCause":
        return "Root cause hypothesis is unavailable for this incident.";
      case "blastRadius":
        return "Blast radius is unavailable for this incident.";
      case "confidence":
        return "Confidence summary is unavailable for this incident.";
      case "checks":
        return "Operator checks are unavailable for this incident.";
      case "chain":
        return "Causal chain is unavailable for this incident.";
      case "evidence":
        return "Evidence summary is unavailable for this incident.";
    }
  }

  return describeBoardState(state);
}
