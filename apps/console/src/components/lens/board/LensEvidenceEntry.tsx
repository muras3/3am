import { useTranslation } from "react-i18next";
import type { CuratedState, EvidenceCounts, ImpactSummary } from "../../../api/curated-types.js";
import type { LensLevel } from "../../../routes/__root.js";
import { sectionFallback } from "./board-state.js";

interface Props {
  counts: EvidenceCounts;
  impact: ImpactSummary;
  state: CuratedState;
  zoomTo: (level: LensLevel, trigger?: HTMLElement, incidentId?: string) => void;
}

function formatTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toISOString().slice(11, 19) + " UTC";
}

export function LensEvidenceEntry({ counts, impact, state, zoomTo }: Props) {
  const { t } = useTranslation();
  const showStateNote =
    state.diagnosis !== "ready" || state.baseline !== "ready" || state.evidenceDensity !== "rich";
  const diagnosisReady = state.diagnosis === "ready";
  const summaryLine = [
    t("board.evidenceEntry.tracesCount", { count: counts.traces }),
    t("board.evidenceEntry.anomalousMetrics", { count: counts.metrics }),
    t("board.evidenceEntry.logsCount", { count: counts.logs }),
  ].join(" · ");

  function handleClick(e: React.MouseEvent<HTMLButtonElement>) {
    zoomTo(2, e.currentTarget);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      zoomTo(2, e.currentTarget);
    }
  }

  return (
    <div className="lens-board-card lens-board-evidence-entry">
      <div className="lens-board-evidence-header">
        <div>
          <div className="lens-board-card-title">{t("board.evidenceEntry.title")}</div>
          <p className="lens-board-evidence-priority">
            {diagnosisReady
              ? t("board.evidenceEntry.priorityReady")
              : t("board.evidenceEntry.priorityPending")}
          </p>
        </div>
        <div className="lens-board-evidence-timestamps">
          <span>{t("board.evidenceEntry.started", { time: formatTime(impact.startedAt) })}</span>
          <span>{t("board.evidenceEntry.fullCascade", { time: formatTime(impact.fullCascadeAt) })}</span>
          <span>{t("board.evidenceEntry.diagnosed", { time: formatTime(impact.diagnosedAt) })}</span>
        </div>
      </div>

      <div className="lens-board-evidence-summary-line">{summaryLine}</div>
      <div className="lens-board-evidence-counts">
        <div className="lens-board-evidence-row">
          <span className="lens-board-ev-label">{t("board.evidenceEntry.traces")}</span>
          <span className="lens-board-ev-value">
            {counts.traces}
            {counts.traceErrors > 0 && (
              <span className="lens-board-ev-errors"> {t("board.evidenceEntry.errors", { count: counts.traceErrors })}</span>
            )}
          </span>
        </div>
        <div className="lens-board-evidence-row">
          <span className="lens-board-ev-label">{t("board.evidenceEntry.metrics")}</span>
          <span className="lens-board-ev-value">{t("board.evidenceEntry.anomalous", { count: counts.metrics })}</span>
        </div>
        <div className="lens-board-evidence-row">
          <span className="lens-board-ev-label">{t("board.evidenceEntry.logs")}</span>
          <span className="lens-board-ev-value">
            {counts.logs}
            {counts.logErrors > 0 && (
              <span className="lens-board-ev-errors"> {t("board.evidenceEntry.errors", { count: counts.logErrors })}</span>
            )}
          </span>
        </div>
      </div>
      {showStateNote ? (
        <div className="lens-board-evidence-note">{sectionFallback(state, "evidence")}</div>
      ) : null}

      <button
        className="lens-board-btn-evidence"
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        aria-label={diagnosisReady ? t("board.evidenceEntry.openEvidenceReady") : t("board.evidenceEntry.openEvidencePending")}
      >
        <span className="lens-board-ev-dot" aria-hidden="true" />
        {diagnosisReady ? t("board.evidenceEntry.openEvidenceReady") : t("board.evidenceEntry.openEvidencePending")}
      </button>
    </div>
  );
}
