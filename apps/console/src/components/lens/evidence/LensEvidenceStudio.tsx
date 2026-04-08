import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../../api/client.js";
import { curatedMutations, curatedQueries } from "../../../api/queries.js";
import { useLensSearch, type LensLevel } from "../../../routes/__root.js";
import { ContextBar } from "./ContextBar.js";
import { LensProofCards } from "./LensProofCards.js";
import { QAFrame, type QAHistoryItem } from "./QAFrame.js";
import { LensEvidenceTabs } from "./LensEvidenceTabs.js";
import { LensSideRail } from "./LensSideRail.js";
import { LensTracesView } from "./LensTracesView.js";
import { LensMetricsView } from "./LensMetricsView.js";
import { LensLogsView } from "./LensLogsView.js";

interface Props {
  incidentId: string;
  zoomTo: (level: LensLevel, trigger?: HTMLElement, incidentId?: string) => void;
}

const NARRATIVE_POLL_INTERVAL_MS = 5_000;

function historyToRequest(history: QAHistoryItem[]) {
  return history.flatMap((entry) => {
    const turns: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: entry.question },
    ];

    if (entry.status === "answered" && entry.response) {
      const assistantContent = entry.response.segments.length > 0
        ? entry.response.segments.map((segment) => segment.text).join(" ")
        : entry.response.noAnswerReason;
      if (assistantContent) {
        turns.push({ role: "assistant", content: assistantContent });
      }
    } else if (entry.status === "failed" && entry.error) {
      turns.push({ role: "assistant", content: entry.error });
    }

    return turns;
  }).slice(-20);
}

export function LensEvidenceStudio({ incidentId }: Props) {
  const { t } = useTranslation();
  const search = useLensSearch();
  const tab = search.tab ?? "traces";
  const [queryDraft, setQueryDraft] = useState(search.query ?? "");
  const [history, setHistory] = useState<QAHistoryItem[]>([]);
  const nextHistoryId = useRef(0);

  const incidentQuery = useQuery(curatedQueries.extendedIncident(incidentId));
  const diagnosisSettings = useQuery(curatedQueries.diagnosisSettings());
  const effectiveDiagnosisSettings = diagnosisSettings.data ?? {
    mode: "automatic" as const,
    bridgeUrl: "http://127.0.0.1:4269",
  };
  const evidenceQuery = useQuery({
    ...curatedQueries.evidence(incidentId),
    refetchInterval: (query) =>
      !import.meta.env?.VITE_USE_FIXTURES
      && incidentQuery.data?.state.diagnosis === "ready"
      && query.state.data?.qa.noAnswerReason === "Diagnosis narrative is not attached to this incident yet."
        ? NARRATIVE_POLL_INTERVAL_MS
        : false,
  });
  const groundedQueryMutation = useMutation(
    curatedMutations.evidenceQuery(incidentId, effectiveDiagnosisSettings),
  );

  const [showGuide, setShowGuide] = useState(() => {
    try { return localStorage.getItem("3am:ev-guide-dismissed") !== "1"; } catch { return true; }
  });
  const dismissGuide = useCallback(() => {
    setShowGuide(false);
    try { localStorage.setItem("3am:ev-guide-dismissed", "1"); } catch { /* noop */ }
  }, []);

  useEffect(() => {
    setQueryDraft(search.query ?? "");
    setHistory([]);
  }, [incidentId, search.query]);

  if (incidentQuery.isLoading || evidenceQuery.isLoading) {
    return (
      <div className="lens-ev-loading" role="status">
        {t("evidence.loading")}
      </div>
    );
  }

  if (incidentQuery.isError || evidenceQuery.isError || !incidentQuery.data || !evidenceQuery.data) {
    return (
      <div className="lens-ev-error" role="alert">
        {t("evidence.error")}
      </div>
    );
  }

  const incident = incidentQuery.data;
  const evidence = evidenceQuery.data;
  const confirmedProofCount = evidence.proofCards.filter((card) => card.status === "confirmed").length;
  const showStatusBanner =
    evidence.state.diagnosis !== "ready"
    || evidence.state.evidenceDensity !== "rich"
    || evidence.state.baseline !== "ready";

  const statusTitle = evidence.state.diagnosis === "pending"
    ? t("evidence.banner.diagnosisPending")
    : evidence.state.evidenceDensity === "sparse"
      ? t("evidence.banner.evidenceSparse")
      : evidence.state.diagnosis === "unavailable"
        ? t("evidence.banner.diagnosisUnavailable")
        : t("evidence.banner.coverageMaturing");

  const statusBody = evidence.state.diagnosis === "pending"
    ? t("evidence.banner.diagnosisPendingBody")
    : evidence.state.evidenceDensity === "sparse"
      ? t("evidence.banner.evidenceSparseBody")
      : evidence.state.diagnosis === "unavailable"
        ? t("evidence.banner.diagnosisUnavailableBody")
        : t("evidence.banner.coverageMaturingBody");

  const statusVisibleNow = [
    t("evidence.visibleNow.proofCards", { count: confirmedProofCount }),
    t("evidence.visibleNow.qaSummary", {
      traces: evidence.qa.evidenceSummary.traces,
      metrics: evidence.qa.evidenceSummary.metrics,
      logs: evidence.qa.evidenceSummary.logs,
    }),
    evidence.surfaces.traces.observed.length > 0
      ? t("evidence.visibleNow.tracesAvailable")
      : t("evidence.visibleNow.tracesReserved"),
  ];

  const statusStillPreparing = [
    evidence.surfaces.metrics.hypotheses.length > 0
      ? t("evidence.stillPreparing.metricsPresent")
      : t("evidence.stillPreparing.metricsWaiting"),
    evidence.surfaces.logs.claims.length > 0
      ? t("evidence.stillPreparing.logsPresent")
      : t("evidence.stillPreparing.logsWaiting"),
    evidence.state.baseline === "ready"
      ? t("evidence.stillPreparing.baselineReady")
      : t("evidence.stillPreparing.baselineOpen"),
  ];

  function handleSubmitQuestion(question: string) {
    const entryId = `qa-${nextHistoryId.current++}`;
    const isFollowup = history.length > 0;
    setHistory((current) => [...current, { id: entryId, question, status: "pending" }]);
    groundedQueryMutation.mutate(
      { question, isFollowup, history: historyToRequest(history) },
      {
        onSuccess: (response) => {
          setHistory((current) =>
            current.map((entry) =>
              entry.id === entryId
                ? { ...entry, status: "answered", response }
                : entry,
            ),
          );
        },
        onError: (error) => {
          const errorMessage = error instanceof ApiError && error.status === 404
            ? t("evidence.qa.qaUnavailable")
            : error instanceof Error
              ? error.message
              : t("evidence.qa.submitFailed");

          setHistory((current) =>
            current.map((entry) =>
              entry.id === entryId
                ? { ...entry, status: "failed", error: errorMessage }
                : entry,
            ),
          );
          if (error instanceof ApiError && error.status === 404) {
            return;
          }
        },
      },
    );
  }

  return (
    <div
      className="lens-ev-studio"
      aria-label={t("evidence.studioLabel")}
      data-evidence-density={evidence.state.evidenceDensity}
      data-diagnosis-state={evidence.state.diagnosis}
    >
      <ContextBar incident={incident} />

      {showGuide && (
        <div className="lens-ev-guide" role="note">
          <p className="lens-ev-guide-text">{t("evidence.guide.message")}</p>
          <button type="button" className="lens-ev-guide-dismiss" onClick={dismissGuide} aria-label={t("evidence.guide.dismiss")}>
            ×
          </button>
        </div>
      )}

      {showStatusBanner && (
        <div className="lens-ev-empty-banner" role="status">
          <div className="lens-ev-empty-pulse" aria-hidden="true" />
          <div className="lens-ev-empty-copy">
            <p className="lens-ev-empty-text">{statusTitle}</p>
            <p className="lens-ev-empty-sub">{statusBody}</p>
          </div>
          <div className="lens-ev-empty-columns">
            <div className="lens-ev-empty-panel">
              <div className="lens-ev-empty-panel-title">{t("evidence.banner.availableNow")}</div>
              <ul className="lens-ev-empty-list">
                {statusVisibleNow.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div className="lens-ev-empty-panel lens-ev-empty-panel-muted">
              <div className="lens-ev-empty-panel-title">{t("evidence.banner.stillFillingIn")}</div>
              <ul className="lens-ev-empty-list">
                {statusStillPreparing.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      <QAFrame
        qa={evidence.qa}
        inputValue={queryDraft}
        history={history}
        isSubmitting={groundedQueryMutation.isPending}
        onInputChange={setQueryDraft}
        onSubmitQuestion={handleSubmitQuestion}
      />

      <div className="lens-ev-tabs-row">
        <LensEvidenceTabs surfaces={evidence.surfaces} />
        <LensProofCards cards={evidence.proofCards} />
      </div>

      <div className="lens-ev-grid">
        <div className="lens-ev-main">
          <div
            role="tabpanel"
            id="ev-panel-traces"
            aria-labelledby="ev-tab-traces"
            className="lens-ev-view"
            hidden={tab !== "traces"}
          >
            <LensTracesView
              surface={evidence.surfaces.traces}
              baselineState={evidence.state.baseline}
              evidenceDensity={evidence.state.evidenceDensity}
            />
          </div>

          <div
            role="tabpanel"
            id="ev-panel-metrics"
            aria-labelledby="ev-tab-metrics"
            className="lens-ev-view"
            hidden={tab !== "metrics"}
          >
            <LensMetricsView
              surface={evidence.surfaces.metrics}
              evidenceDensity={evidence.state.evidenceDensity}
              isActive={tab === "metrics"}
            />
          </div>

          <div
            role="tabpanel"
            id="ev-panel-logs"
            aria-labelledby="ev-tab-logs"
            className="lens-ev-view"
            hidden={tab !== "logs"}
          >
            <LensLogsView
              surface={evidence.surfaces.logs}
              evidenceDensity={evidence.state.evidenceDensity}
              isActive={tab === "logs"}
            />
          </div>
        </div>

        <LensSideRail
          notes={evidence.sideNotes}
          diagnosisState={evidence.state.diagnosis}
          baselineState={evidence.state.baseline}
        />
      </div>
    </div>
  );
}
