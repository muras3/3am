import { lazy, Suspense, useState } from "react";
import type { Incident } from "../../api/types.js";
import type { EvidenceEntryVM } from "../../lib/viewmodels/index.js";
import {
  buildIncidentWorkspaceVM,
  buildEvidenceStudioVM,
} from "../../lib/viewmodels/index.js";
import { WhatHappened } from "./WhatHappened.js";
import { ImmediateAction } from "./ImmediateAction.js";
import { RecoveryCard } from "./RecoveryCard.js";
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

  // EvidenceEntry counts come from the packet directly — always available regardless
  // of diagnosis state, so operators can inspect raw OTel data while LLM runs.
  const evidenceVM: EvidenceEntryVM = vm?.evidence ?? {
    traces: incident.packet.evidence.representativeTraces.length,
    metrics: incident.packet.evidence.changedMetrics.length,
    logs: incident.packet.evidence.relevantLogs.length,
  };

  return (
    <>
      {vm ? (
        <>
          <WhatHappened headline={vm.headline} chips={vm.chips} />
          <ImmediateAction action={vm.action} />
          <RecoveryCard recovery={vm.recovery} />
          <CauseCard cause={vm.cause} />
        </>
      ) : (
        <DiagnosisPending />
      )}
      <EvidenceEntry
        evidence={evidenceVM}
        onOpenStudio={() => setStudioOpen(true)}
      />
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
