import { lazy, Suspense, useState } from "react";
import type { Incident } from "../../api/types.js";
import { WhatHappened } from "./WhatHappened.js";
import { ImmediateAction } from "./ImmediateAction.js";
import { CausalChain } from "./CausalChain.js";
import { BottomGrid } from "./BottomGrid.js";
import { DiagnosisPending } from "../common/DiagnosisPending.js";

// EvidenceStudio is lazy-loaded (ADR 0025 responsiveness-first)
const EvidenceStudio = lazy(() =>
  import("../evidence/EvidenceStudio.js").then((m) => ({
    default: m.EvidenceStudio,
  })),
);

interface Props {
  incident: Incident;
}

export function IncidentBoard({ incident }: Props) {
  const [studioOpen, setStudioOpen] = useState(false);
  const dr = incident.diagnosisResult;

  return (
    <>
      {dr ? (
        <>
          <WhatHappened incident={incident} />
          <ImmediateAction diagnosisResult={dr} />
          <CausalChain steps={dr.reasoning.causal_chain} />
        </>
      ) : (
        <DiagnosisPending />
      )}
      <BottomGrid
        incident={incident}
        diagnosisResult={dr}
        onOpenStudio={() => setStudioOpen(true)}
      />
      {studioOpen && (
        <Suspense fallback={null}>
          <EvidenceStudio
            incident={incident}
            onClose={() => setStudioOpen(false)}
          />
        </Suspense>
      )}
    </>
  );
}
