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

interface Props {
  incidentId: string;
  zoomTo: (level: LensLevel, trigger?: HTMLElement) => void;
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

  if (data.state.diagnosis === "pending") {
    return <DiagnosisPending />;
  }

  return (
    <div className="lens-board-content stagger">
      {/* 1. Identity */}
      <WhatHappened
        incidentId={data.incidentId}
        severity={data.severity}
        headline={data.headline}
        chips={data.chips}
      />

      {/* 2. Action Hero */}
      <ImmediateAction action={data.action} />

      {/* 3. Context Grid */}
      <div className="lens-board-context-grid">
        <BlastRadius entries={data.blastRadius} />
        <ConfidenceCard confidence={data.confidenceSummary} />
        <OperatorCheck checks={data.operatorChecks} />
      </div>

      {/* 4. Root Cause Hypothesis */}
      <RootCauseHypothesis hypothesis={data.rootCauseHypothesis} />

      {/* 5. Causal Chain */}
      <CauseCard steps={data.causalChain} />

      {/* 6. Evidence Summary */}
      <LensEvidenceEntry
        counts={data.evidenceSummary}
        impact={data.impactSummary}
        zoomTo={zoomTo}
      />
    </div>
  );
}
