import { useTranslation } from "react-i18next";
import type { CuratedState, IncidentAction } from "../../../api/curated-types.js";
import { sectionFallback } from "./board-state.js";
import { splitActionForViewport } from "./viewport-text.js";

interface Props {
  action: IncidentAction;
  state: CuratedState;
}

export function ImmediateAction({ action, state }: Props) {
  const { t } = useTranslation();
  const text = action.text.trim() || sectionFallback(state, "action");
  const rationale = action.rationale.trim() || sectionFallback(state, "action");
  const doNot = action.doNot.trim();
  const actionSteps = splitActionForViewport(text);
  const doNotText = doNot || t("board.immediateAction.doNotEmpty");
  const isDirectional =
    state.diagnosis !== "ready" || state.evidenceDensity === "sparse";
  const title = isDirectional ? t("board.immediateAction.titleDirectional") : t("board.immediateAction.title");
  const doNotLabel = isDirectional ? t("board.immediateAction.doNotLabelDirectional") : t("board.immediateAction.doNotLabel");

  return (
    <div className="lens-board-action-hero">
      <div className="lens-board-action-eyebrow">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="14" height="14">
          <path
            d="M8 1l2.5 5 5.5.8-4 3.9.9 5.3L8 13.3 3.1 16l.9-5.3-4-3.9 5.5-.8z"
            fill="currentColor"
          />
        </svg>
        {title}
      </div>
      {isDirectional ? (
        <p className="lens-board-action-intro">
          {t("board.immediateAction.directionalIntro")}
        </p>
      ) : null}
      <div className="lens-board-action-steps" role="list" aria-label={t("board.immediateAction.stepsLabel")}>
        {actionSteps.map((step, index) => (
          <div key={`${step}-${index}`} className="lens-board-action-step" role="listitem">
            <span className="lens-board-action-step-index">{index + 1}</span>
            <span className="lens-board-action-step-text">{step}</span>
          </div>
        ))}
      </div>

      {/* DO NOT — always visible, safety-critical */}
      <div
        className={`lens-board-action-donot-block${doNot ? "" : " lens-board-action-donot-empty"}`}
      >
        <strong>{doNotLabel}</strong>
        <span>{doNotText}</span>
      </div>

      {/* WHY — collapsed by default */}
      <details className="lens-board-inline-details">
        <summary>{t("board.immediateAction.whyLabel")}</summary>
        <div className="lens-board-inline-details-body">{rationale}</div>
      </details>
    </div>
  );
}
