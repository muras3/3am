import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../../api/client.js";
import { curatedMutations, curatedQueries } from "../../../api/queries.js";
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
  const queryClient = useQueryClient();
  const [rerunFeedback, setRerunFeedback] = useState<string | null>(null);
  const { data, isLoading, isError } = useQuery(
    curatedQueries.extendedIncident(incidentId),
  );
  const rerunDiagnosis = useMutation(curatedMutations.rerunDiagnosis(incidentId));

  function openEvidence(trigger?: HTMLElement) {
    zoomTo(2, trigger);
  }

  function handleRerunDiagnosis() {
    setRerunFeedback(null);
    rerunDiagnosis.mutate(undefined, {
      onSuccess: () => {
        setRerunFeedback("Diagnosis re-run requested. This board will refresh automatically.");
        void queryClient.invalidateQueries({ queryKey: curatedQueries.extendedIncident(incidentId).queryKey });
        void queryClient.invalidateQueries({ queryKey: curatedQueries.evidence(incidentId).queryKey });
      },
      onError: (error) => {
        if (error instanceof ApiError && error.status === 409) {
          setRerunFeedback("Diagnosis is already running. This board will refresh automatically.");
          void queryClient.invalidateQueries({ queryKey: curatedQueries.extendedIncident(incidentId).queryKey });
          void queryClient.invalidateQueries({ queryKey: curatedQueries.evidence(incidentId).queryKey });
          return;
        }
        setRerunFeedback("Could not start a new diagnosis run. Try again in a moment.");
      },
    });
  }

  const shouldPollForRerun =
    !import.meta.env?.VITE_USE_FIXTURES &&
    (rerunDiagnosis.isPending || data?.state.diagnosis === "pending");

  useEffect(() => {
    if (!shouldPollForRerun) return;

    const timer = window.setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: curatedQueries.extendedIncident(incidentId).queryKey });
      void queryClient.invalidateQueries({ queryKey: curatedQueries.evidence(incidentId).queryKey });
    }, 1500);

    return () => {
      window.clearInterval(timer);
    };
  }, [shouldPollForRerun, incidentId, queryClient]);

  useEffect(() => {
    if (data?.state.diagnosis === "ready" && rerunFeedback) {
      setRerunFeedback(null);
    }
  }, [data?.state.diagnosis, rerunFeedback]);

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

  const confirmedNow = [
    `${data.severity.toUpperCase()} severity and incident timing are confirmed.`,
    data.blastRadius.length > 0
      ? `${data.blastRadius.length} impacted service path${data.blastRadius.length === 1 ? "" : "s"} already visible in blast radius.`
      : "The blast-radius panel is reserved and will fill as affected paths are confirmed.",
    data.evidenceSummary.traces + data.evidenceSummary.metrics + data.evidenceSummary.logs > 0
      ? `${data.evidenceSummary.traces} traces, ${data.evidenceSummary.metrics} metrics, and ${data.evidenceSummary.logs} logs can already be inspected.`
      : "Evidence Studio is open now, even while correlation is still collecting its first signals.",
  ];

  const notYetConfirmed = [
    "A durable root-cause narrative until traces, metrics, and logs agree on the same trigger.",
    "Whether the first visible dependency is the cause or only adjacent impact.",
    "Full confidence language and downstream propagation timing.",
  ];

  const nextSteps = [
    "Open Evidence Studio and inspect the first failing trace before broad remediation.",
    "Use the next operator step as a safe triage move, not as final root cause confirmation.",
    "Reserve re-run diagnosis for when the retry API becomes available.",
  ];

  const hasDiagnosisGap = data.state.diagnosis !== "ready";
  const rerunAcknowledged =
    rerunFeedback?.startsWith("Diagnosis re-run requested")
    || rerunFeedback?.startsWith("Diagnosis is already running");
  const rerunDisabled =
    rerunDiagnosis.isPending || rerunAcknowledged || data.state.diagnosis === "pending";
  const rerunLabel = rerunDiagnosis.isPending ? "Starting re-run…" : "Re-run diagnosis";
  const pendingMessage =
    rerunDiagnosis.isPending || rerunFeedback?.startsWith("Diagnosis re-run requested")
      ? "Diagnosis re-run is in progress"
      : "Diagnosis is still assembling";
  const rerunNote = rerunFeedback ?? (
    data.state.diagnosis === "pending"
      ? "Diagnosis is already running. Stay on the evidence lanes until this run finishes."
      : "Use this to request one new diagnosis run from the current incident evidence."
  );

  return (
    <div className="lens-board-content stagger">
      <WhatHappened
        incidentId={data.incidentId}
        severity={data.severity}
        headline={data.headline}
        chips={data.chips}
        state={data.state}
      />

      {hasDiagnosisGap ? (
        <DiagnosisPending
          status={data.state.diagnosis === "pending" ? "pending" : "unavailable"}
          message={
            data.state.diagnosis === "pending"
              ? pendingMessage
              : "Narrative diagnosis is unavailable"
          }
          subtext={describeBoardState(data.state)}
          confirmedNow={confirmedNow}
          notYetConfirmed={notYetConfirmed}
          nextSteps={nextSteps}
          onOpenEvidence={openEvidence}
          onRerunDiagnosis={handleRerunDiagnosis}
          rerunDisabled={rerunDisabled}
          rerunLabel={rerunLabel}
          rerunNote={rerunNote}
        />
      ) : null}

      <div className="lens-board-priority-grid">
        <ImmediateAction action={data.action} state={data.state} />
        <LensEvidenceEntry
          counts={data.evidenceSummary}
          impact={data.impactSummary}
          state={data.state}
          zoomTo={zoomTo}
        />
      </div>

      <div className="lens-board-insight-grid">
        <RootCauseHypothesis hypothesis={data.rootCauseHypothesis} state={data.state} />
        <ConfidenceCard confidence={data.confidenceSummary} state={data.state} />
      </div>

      <div className="lens-board-context-grid">
        <BlastRadius entries={data.blastRadius} state={data.state} />
        <OperatorCheck checks={data.operatorChecks} state={data.state} />
      </div>

      <CauseCard steps={data.causalChain} state={data.state} />
    </div>
  );
}
