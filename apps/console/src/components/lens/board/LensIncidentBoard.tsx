import { useQuery } from "@tanstack/react-query";
import { curatedQueries } from "../../../api/queries.js";
import type { LensLevel } from "../../../routes/__root.js";
import { WhatHappened } from "./WhatHappened.js";
import { ImmediateAction } from "./ImmediateAction.js";
import { BlastRadius } from "./BlastRadius.js";
import { ConfidenceCard } from "./ConfidenceCard.js";
import { OperatorCheck } from "./OperatorCheck.js";
import { RootCauseHypothesis } from "./RootCauseHypothesis.js";
import { CauseCard } from "./CauseCard.js";
import { LensEvidenceEntry } from "./LensEvidenceEntry.js";
import { DiagnosisPending } from "./DiagnosisPending.js";
import { describeBoardState } from "./board-state.js";

interface Props {
  incidentId: string;
  zoomTo: (level: LensLevel, trigger?: HTMLElement, incidentId?: string) => void;
}

export function LensIncidentBoard({ incidentId, zoomTo }: Props) {
  const { data, isLoading, isError } = useQuery(
    curatedQueries.extendedIncident(incidentId),
  );

  if (isLoading) {
    return (
      <div className="lens-board-loading" role="status">
        Loading…
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="lens-board-error" role="alert">
        Failed to load incident data.
      </div>
    );
  }

  return (
    <div className="lens-board-content stagger">
      {data.state.diagnosis !== "ready" ? (
        <DiagnosisPending
          message={
            data.state.diagnosis === "pending"
              ? "Diagnosis in progress…"
              : "Diagnosis unavailable"
          }
          subtext={describeBoardState(data.state)}
        />
      ) : null}

      {/* 1. Identity */}
      <WhatHappened
        incidentId={data.incidentId}
        severity={data.severity}
        headline={data.headline}
        chips={data.chips}
        state={data.state}
      />

      {/* 2. Action Hero */}
      <ImmediateAction action={data.action} state={data.state} />

      {/* 3. Context Grid */}
      <div className="lens-board-context-grid">
        <BlastRadius entries={data.blastRadius} state={data.state} />
        <ConfidenceCard confidence={data.confidenceSummary} state={data.state} />
        <OperatorCheck checks={data.operatorChecks} state={data.state} />
      </div>

      {/* 4. Root Cause Hypothesis */}
      <RootCauseHypothesis hypothesis={data.rootCauseHypothesis} state={data.state} />

      {/* 5. Causal Chain */}
      <CauseCard steps={data.causalChain} state={data.state} />

      {/* 6. Evidence Summary */}
      <LensEvidenceEntry
        counts={data.evidenceSummary}
        impact={data.impactSummary}
        state={data.state}
        zoomTo={zoomTo}
      />
    </div>
  );
}
