import { useTranslation } from "react-i18next";

interface Props {
  status: "pending" | "unavailable";
  message?: string;
  subtext?: string;
  confirmedNow?: string[];
  notYetConfirmed?: string[];
  nextSteps?: string[];
  onOpenEvidence?: (trigger?: HTMLElement) => void;
  onRerunDiagnosis?: () => void;
  rerunDisabled?: boolean;
  rerunLabel?: string;
  rerunNote?: string;
}

export function DiagnosisPending({
  status,
  message,
  subtext,
  confirmedNow = [],
  notYetConfirmed = [],
  nextSteps = [],
  onOpenEvidence,
  onRerunDiagnosis,
  rerunDisabled = true,
  rerunLabel,
  rerunNote,
}: Props) {
  const { t } = useTranslation();
  const effectiveRerunLabel = rerunLabel ?? t("board.diagnosisPending.rerunDefault");
  return (
    <div className="lens-board-pending" role="status" aria-live="polite">
      <div className="lens-board-pending-head">
        <div className="lens-board-pending-pulse" aria-hidden="true" />
        <div className="lens-board-pending-copy">
          <p className="lens-board-pending-kicker">{t("board.diagnosisPending.statusLabel")}</p>
          <p className="lens-board-pending-text">{message ?? t("board.diagnosisPending.defaultMessage")}</p>
          <p className="lens-board-pending-sub">
            {subtext ?? t("board.diagnosisPending.defaultSubtext")}
          </p>
        </div>
      </div>

      <div className="lens-board-pending-columns">
        <div className="lens-board-pending-panel">
          <div className="lens-board-pending-panel-title">{t("board.diagnosisPending.confirmedNow")}</div>
          <ul className="lens-board-pending-list">
            {confirmedNow.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>

        <div className="lens-board-pending-panel lens-board-pending-panel-muted">
          <div className="lens-board-pending-panel-title">{t("board.diagnosisPending.notConfirmedYet")}</div>
          <ul className="lens-board-pending-list">
            {notYetConfirmed.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </div>

      <div className="lens-board-pending-operator">
        <div className="lens-board-pending-panel lens-board-pending-panel-strong">
          <div className="lens-board-pending-panel-title">{t("board.diagnosisPending.operatorNextStep")}</div>
          <ul className="lens-board-pending-list">
            {nextSteps.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>

        <div className="lens-board-pending-actions">
          <button
            type="button"
            className="lens-board-btn-evidence lens-board-btn-evidence-secondary"
            aria-label={t("board.diagnosisPending.openEvidenceLabel")}
            onClick={(event) => onOpenEvidence?.(event.currentTarget)}
          >
            {t("board.diagnosisPending.openEvidenceStudioFirst")}
          </button>
          <button
            type="button"
            className="lens-board-btn-evidence lens-board-btn-evidence-tertiary"
            disabled={rerunDisabled}
            aria-describedby="lens-board-rerun-note"
            onClick={onRerunDiagnosis}
          >
            {effectiveRerunLabel}
          </button>
          <p id="lens-board-rerun-note" className="lens-board-pending-note">
            {rerunNote ?? (
              status === "pending"
                ? t("board.diagnosisPending.rerunPendingNote")
                : t("board.diagnosisPending.rerunDefaultNote")
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
