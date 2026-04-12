import i18n from "../../../i18n/index.js";
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

const t = (key: string) => i18n.t(key);

export function describeBoardState(state: CuratedState): string {
  if (state.diagnosis === "pending") return t("boardState.diagnosisPending");
  if (state.diagnosis === "unavailable") return t("boardState.diagnosisUnavailable");
  if (state.evidenceDensity === "empty") return t("boardState.evidenceEmpty");
  if (state.evidenceDensity === "sparse") return t("boardState.evidenceSparse");
  if (state.baseline === "insufficient") return t("boardState.baselineInsufficient");
  if (state.baseline === "unavailable") return t("boardState.baselineUnavailable");
  return t("boardState.default");
}

export function sectionFallback(state: CuratedState, section: Section): string {
  if (state.diagnosis === "pending") {
    return t(`boardState.fallback.pending.${section}`);
  }

  if (state.evidenceDensity === "sparse") {
    return t(`boardState.fallback.sparse.${section}`);
  }

  if (state.diagnosis === "unavailable") {
    return t(`boardState.fallback.unavailable.${section}`);
  }

  return describeBoardState(state);
}
