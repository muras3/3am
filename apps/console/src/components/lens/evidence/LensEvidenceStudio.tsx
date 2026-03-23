import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSearch } from "@tanstack/react-router";
import { ApiError } from "../../../api/client.js";
import { curatedMutations, curatedQueries, type ChatTurn } from "../../../api/queries.js";
import type { LensLevel, LensSearchParams } from "../../../routes/__root.js";
import { ContextBar } from "./ContextBar.js";
import { LensProofCards } from "./LensProofCards.js";
import { QAFrame } from "./QAFrame.js";
import { LensEvidenceTabs } from "./LensEvidenceTabs.js";
import { LensSideRail } from "./LensSideRail.js";
import { LensTracesView } from "./LensTracesView.js";
import { LensMetricsView } from "./LensMetricsView.js";
import { LensLogsView } from "./LensLogsView.js";

interface Props {
  incidentId: string;
  zoomTo: (level: LensLevel, trigger?: HTMLElement, incidentId?: string) => void;
}

/**
 * LensEvidenceStudio — Level 2 orchestration component.
 *
 * Layout:
 *   context bar → proof cards → Q&A frame → tabs → content grid (main + side rail)
 */
export function LensEvidenceStudio({ incidentId }: Props) {
  const search = useSearch({ from: "__root__" }) as LensSearchParams;
  const tab = search.tab ?? "traces";
  const [queryDraft, setQueryDraft] = useState(search.query ?? "");
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [latestReply, setLatestReply] = useState<string>();
  const [submitError, setSubmitError] = useState<string>();

  const incidentQuery = useQuery(curatedQueries.extendedIncident(incidentId));
  const evidenceQuery = useQuery(curatedQueries.evidence(incidentId));
  const chatMutation = useMutation(curatedMutations.chat(incidentId));

  // Must be before early returns — React requires consistent hook call order.
  const evidenceQaQuestion = evidenceQuery.data?.qa.question;
  useEffect(() => {
    if (evidenceQaQuestion != null) {
      setQueryDraft(search.query ?? evidenceQaQuestion);
    }
  }, [evidenceQaQuestion, search.query]);

  if (incidentQuery.isLoading || evidenceQuery.isLoading) {
    return (
      <div className="lens-ev-loading" role="status">
        Loading evidence…
      </div>
    );
  }

  if (incidentQuery.isError || evidenceQuery.isError || !incidentQuery.data || !evidenceQuery.data) {
    return (
      <div className="lens-ev-error" role="alert">
        Failed to load evidence data.
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
    ? "Evidence Studio is live while diagnosis assembles"
    : evidence.state.evidenceDensity === "sparse"
      ? "A directional read is available now"
      : evidence.state.diagnosis === "unavailable"
        ? "Evidence Studio remains available without a narrative diagnosis"
        : "Evidence coverage is still maturing";

  const statusBody = evidence.state.diagnosis === "pending"
    ? "Use the confirmed traces and logs first. Metrics, confidence wording, and the final narrative will tighten as correlation completes."
    : evidence.state.evidenceDensity === "sparse"
      ? "The strongest confirmed signals are shown first. Treat missing lanes as open questions, not as healthy evidence."
      : evidence.state.diagnosis === "unavailable"
        ? "Confirmed telemetry remains reviewable here. The system is withholding narrative claims it cannot support."
        : "Observed behavior is available now, but baseline or comparison coverage is still limited.";

  const statusVisibleNow = [
    `${confirmedProofCount} proof card${confirmedProofCount === 1 ? "" : "s"} already point to confirmed evidence.`,
    `${evidence.qa.evidenceSummary.traces} traces, ${evidence.qa.evidenceSummary.metrics} metrics, and ${evidence.qa.evidenceSummary.logs} logs are currently summarized in the Q&A frame.`,
    evidence.surfaces.traces.observed.length > 0
      ? "Traces can be opened now to inspect the first failing path."
      : "Trace lane stays reserved and will populate as the first captured request arrives.",
  ];

  const statusStillPreparing = [
    evidence.surfaces.metrics.hypotheses.length > 0
      ? "Metric comparison is already present and will sharpen as more samples arrive."
      : "Metric comparison will appear once drift repeats across enough samples.",
    evidence.surfaces.logs.claims.length > 0
      ? "Log clusters are visible now; absence evidence may still be added."
      : "Log clusters will pin confirmed patterns and absences here once correlation completes.",
    evidence.state.baseline === "ready"
      ? "Baseline context is attached and may still expand with more comparable requests."
      : "Expected baseline remains open, so recovery and comparison guidance stays provisional.",
  ];

  function handleSubmitQuestion(question: string) {
    setSubmitError(undefined);
    chatMutation.mutate(
      {
        message: question,
        history,
      },
      {
        onSuccess: ({ reply }) => {
          setHistory((prev) => [
            ...prev,
            { role: "user", content: question },
            { role: "assistant", content: reply },
          ]);
          setLatestReply(reply);
        },
        onError: (error) => {
          if (error instanceof ApiError && error.status === 404) {
            setSubmitError("Free-form Q&A will open once diagnosis links enough evidence. The prepared surfaces below are ready now.");
            return;
          }
          setSubmitError(error instanceof Error ? error.message : "Failed to submit question.");
        },
      },
    );
  }

  return (
    <div
      className="lens-ev-studio"
      aria-label="Evidence Studio"
      data-evidence-density={evidence.state.evidenceDensity}
      data-diagnosis-state={evidence.state.diagnosis}
    >
      {/* Context bar — keeps incident context visible */}
      <ContextBar incident={incident} />

      {showStatusBanner && (
        <div className="lens-ev-empty-banner" role="status">
          <div className="lens-ev-empty-pulse" aria-hidden="true" />
          <div className="lens-ev-empty-copy">
            <p className="lens-ev-empty-text">{statusTitle}</p>
            <p className="lens-ev-empty-sub">{statusBody}</p>
          </div>
          <div className="lens-ev-empty-columns">
            <div className="lens-ev-empty-panel">
              <div className="lens-ev-empty-panel-title">Available now</div>
              <ul className="lens-ev-empty-list">
                {statusVisibleNow.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div className="lens-ev-empty-panel lens-ev-empty-panel-muted">
              <div className="lens-ev-empty-panel-title">Still filling in</div>
              <ul className="lens-ev-empty-list">
                {statusStillPreparing.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Proof cards grid */}
      <LensProofCards cards={evidence.proofCards} />

      {/* Q&A frame */}
      <QAFrame
        qa={evidence.qa}
        inputValue={queryDraft}
        isSubmitting={chatMutation.isPending}
        submitError={submitError}
        latestReply={latestReply}
        onInputChange={setQueryDraft}
        onSubmitQuestion={handleSubmitQuestion}
      />

      {/* Tab bar */}
      <LensEvidenceTabs surfaces={evidence.surfaces} />

      {/* Content grid: main + side rail */}
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

        {/* Right side rail */}
        <LensSideRail
          notes={evidence.sideNotes}
          diagnosisState={evidence.state.diagnosis}
          baselineState={evidence.state.baseline}
        />
      </div>
    </div>
  );
}
