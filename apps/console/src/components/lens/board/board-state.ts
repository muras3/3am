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
  if (state.diagnosis === "pending") {
    return "Severity, timing, and evidence lanes are visible now. The diagnosis narrative is still being assembled.";
  }
  if (state.diagnosis === "unavailable") {
    return "A narrative diagnosis could not be produced. Confirmed telemetry remains available for manual review.";
  }
  if (state.evidenceDensity === "empty") {
    return "Evidence lanes are prepared, but the first traces, metrics, and log clusters are still arriving.";
  }
  if (state.evidenceDensity === "sparse") {
    return "A first-pass diagnosis is available. Treat it as directional until more evidence fills in the gaps.";
  }
  if (state.baseline === "insufficient") return "Observed behavior is visible now; expected baseline coverage is still limited.";
  if (state.baseline === "unavailable") return "Observed behavior is visible now; no reliable baseline is attached yet.";
  return "Core incident context is visible. Supporting evidence is still maturing.";
}

export function sectionFallback(state: CuratedState, section: Section): string {
  if (state.diagnosis === "pending") {
    switch (section) {
      case "headline":
        return "Impact is confirmed. Diagnosis narrative is still taking shape.";
      case "action":
        return "Start with the evidence lanes below and verify the first failing request before taking broad remediation steps.";
      case "rootCause":
        return "A root-cause narrative will appear after traces, metrics, and logs align on the same explanation.";
      case "blastRadius":
        return "Service impact will expand here as the system confirms which downstream paths share this failure pattern.";
      case "confidence":
        return "Confidence is building from deterministic evidence. Expect a clearer score once multiple surfaces agree.";
      case "checks":
        return "Use the current traces, metrics, and logs to confirm the first failing path while diagnosis continues.";
      case "chain":
        return "The causal chain stays reserved until the trigger, propagation path, and user impact can be linked safely.";
      case "evidence":
        return "Evidence Studio is already useful now. Counts and milestones will tighten as more telemetry is correlated.";
    }
  }

  if (state.evidenceDensity === "sparse") {
    switch (section) {
      case "headline":
        return "A partial diagnosis is available. Some impact is confirmed, but the full story is still forming.";
      case "action":
        return "Use the confirmed signals first, then validate any gaps before applying irreversible remediation.";
      case "rootCause":
        return "This hypothesis is directional. Keep validating adjacent dependencies and baseline drift.";
      case "blastRadius":
        return "Confirmed impact is shown here first. Additional affected paths will appear as telemetry fills in.";
      case "confidence":
        return "Confidence remains intentionally conservative until more than one evidence surface agrees.";
      case "checks":
        return "Prioritize checks that validate the currently confirmed trigger and rule out nearby false positives.";
      case "chain":
        return "Only the confirmed segment of the chain is shown. Upstream and downstream links remain open.";
      case "evidence":
        return "Evidence Studio contains the strongest confirmed signals now; other lanes remain open for comparison.";
    }
  }

  if (state.diagnosis === "unavailable") {
    switch (section) {
      case "headline":
        return "No narrative diagnosis was produced for this incident.";
      case "action":
        return "Use the confirmed evidence surfaces to decide the next operator step.";
      case "rootCause":
        return "A root-cause narrative is not available. Review the confirmed telemetry instead.";
      case "blastRadius":
        return "Blast radius will expand here if additional affected paths are confirmed.";
      case "confidence":
        return "Confidence cannot be summarized automatically yet.";
      case "checks":
        return "Use Evidence Studio to verify the first failing path and dependency behavior.";
      case "chain":
        return "The causal chain is intentionally withheld until the system can connect the steps safely.";
      case "evidence":
        return "Evidence Studio remains the best place to review confirmed traces, metrics, and logs.";
    }
  }

  return describeBoardState(state);
}
