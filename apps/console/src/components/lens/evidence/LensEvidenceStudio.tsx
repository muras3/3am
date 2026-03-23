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

  useEffect(() => {
    setQueryDraft(search.query ?? evidence.qa.question);
  }, [evidence.qa.question, search.query]);

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
            setSubmitError("Query transport is unavailable until diagnosis is ready.");
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

      {evidence.state.evidenceDensity === "empty" && (
        <div className="lens-ev-empty-banner" role="status">
          <div className="lens-ev-empty-pulse" aria-hidden="true" />
          <div>
            <p className="lens-ev-empty-text">Evidence is being collected…</p>
            <p className="lens-ev-empty-sub">
              The major Evidence Studio panels remain available while deterministic telemetry arrives.
            </p>
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
