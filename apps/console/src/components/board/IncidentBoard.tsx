import { lazy, Suspense, useState } from "react";
import type { Incident } from "../../api/types.js";
import {
  buildIncidentWorkspaceVM,
  buildEvidenceEntryVM,
  buildEvidenceStudioVM,
} from "../../lib/viewmodels/index.js";
import { WhatHappened } from "./WhatHappened.js";
import { ImmediateAction } from "./ImmediateAction.js";
import { ImpactTimeline } from "./ImpactTimeline.js";
import { CauseCard } from "./CauseCard.js";
import { EvidenceEntry } from "./EvidenceEntry.js";
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
  const vm = buildIncidentWorkspaceVM(incident);
  const studioVM = buildEvidenceStudioVM(incident);

  // Evidence counts always available from packet — operators inspect raw OTel while LLM runs.
  const evidenceVM = vm?.evidence ?? buildEvidenceEntryVM(incident.packet);

  return (
    <>
      {vm ? (
        <>
          <WhatHappened headline={vm.headline} chips={vm.chips} />
          <ImmediateAction action={vm.action} />
          <CauseCard cause={vm.cause} />
          <div className="bottom-grid">
            <ImpactTimeline timeline={vm.timeline} />
            <EvidenceEntry
              evidence={evidenceVM}
              onOpenStudio={() => setStudioOpen(true)}
            />
          </div>
        </>
      ) : (
        <>
          <DiagnosisPending />
          <EvidenceEntry
            evidence={evidenceVM}
            onOpenStudio={() => setStudioOpen(true)}
          />
        </>
      )}
      {studioOpen && (
        <Suspense fallback={null}>
          <EvidenceStudio
            incident={incident}
            studioVM={studioVM}
            onClose={() => setStudioOpen(false)}
          />
        </Suspense>
      )}
    </>
  );
}
