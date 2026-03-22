import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { curatedQueries } from "../../../api/queries.js";
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
 *
 * Shows EmptyView when evidenceDensity === 'empty'.
 */
export function LensEvidenceStudio({ incidentId }: Props) {
  const search = useSearch({ from: "__root__" }) as LensSearchParams;
  const tab = search.tab ?? "traces";

  const incidentQuery = useQuery(curatedQueries.extendedIncident(incidentId));
  const evidenceQuery = useQuery(curatedQueries.evidence(incidentId));

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

  // Empty state when evidence density is empty
  if (evidence.state.evidenceDensity === "empty") {
    return (
      <div className="lens-ev-empty" role="status" aria-label="Evidence Studio">
        <ContextBar incident={incident} />
        <div className="lens-ev-empty-body">
          <div className="lens-ev-empty-pulse" aria-hidden="true" />
          <p className="lens-ev-empty-text">Evidence is being collected…</p>
          <p className="lens-ev-empty-sub">
            Diagnosis is in progress. Check back in a moment.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="lens-ev-studio" aria-label="Evidence Studio">
      {/* Context bar — keeps incident context visible */}
      <ContextBar incident={incident} />

      {/* Proof cards grid */}
      <LensProofCards cards={evidence.proofCards} />

      {/* Q&A frame */}
      <QAFrame qa={evidence.qa} diagnosisState={evidence.state.diagnosis} />

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
            <LensTracesView surface={evidence.surfaces.traces} />
          </div>

          <div
            role="tabpanel"
            id="ev-panel-metrics"
            aria-labelledby="ev-tab-metrics"
            className="lens-ev-view"
            hidden={tab !== "metrics"}
          >
            <LensMetricsView surface={evidence.surfaces.metrics} />
          </div>

          <div
            role="tabpanel"
            id="ev-panel-logs"
            aria-labelledby="ev-tab-logs"
            className="lens-ev-view"
            hidden={tab !== "logs"}
          >
            <LensLogsView surface={evidence.surfaces.logs} />
          </div>
        </div>

        {/* Right side rail */}
        <LensSideRail notes={evidence.sideNotes} />
      </div>
    </div>
  );
}
