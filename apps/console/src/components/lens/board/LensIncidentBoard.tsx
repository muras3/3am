import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../../api/client.js";
import { curatedMutations, curatedQueries } from "../../../api/queries.js";
import type { LensLevel } from "../../../routes/__root.js";
import { WhatHappened } from "./WhatHappened.js";
import { ImmediateAction } from "./ImmediateAction.js";
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

const DIAGNOSIS_POLL_INTERVAL_MS = 5_000;

export function LensIncidentBoard({ incidentId, zoomTo }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [rerunFeedback, setRerunFeedback] = useState<string | null>(null);
  const [closeFeedback, setCloseFeedback] = useState<string | null>(null);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const rerunDiagnosis = useMutation(curatedMutations.rerunDiagnosis(incidentId));
  const closeIncident = useMutation(curatedMutations.closeIncident(incidentId));
  const incidentQuery = useQuery({
    ...curatedQueries.extendedIncident(incidentId),
    refetchInterval: (query) => {
      const incident = query.state.data;
      return !import.meta.env?.VITE_USE_FIXTURES
        && (rerunDiagnosis.isPending || incident?.state.diagnosis === "pending")
        ? DIAGNOSIS_POLL_INTERVAL_MS
        : false;
    },
  });
  const { data, isLoading, isError } = incidentQuery;

  function openEvidence(trigger?: HTMLElement) {
    zoomTo(2, trigger);
  }

  function handleRerunDiagnosis() {
    setRerunFeedback(null);
    rerunDiagnosis.mutate(undefined, {
      onSuccess: () => {
        setRerunFeedback(t("board.rerun.requested"));
        void queryClient.invalidateQueries({ queryKey: curatedQueries.extendedIncident(incidentId).queryKey });
      },
      onError: (error) => {
        if (error instanceof ApiError && error.status === 409) {
          setRerunFeedback(t("board.rerun.alreadyRunning"));
          void queryClient.invalidateQueries({ queryKey: curatedQueries.extendedIncident(incidentId).queryKey });
          return;
        }
        setRerunFeedback(t("board.rerun.failed"));
      },
    });
  }

  function handleCloseIncident() {
    setCloseFeedback(null);
    closeIncident.mutate(undefined, {
      onSuccess: () => {
        setCloseFeedback(t("board.close.requested"));
        void queryClient.invalidateQueries({ queryKey: curatedQueries.extendedIncident(incidentId).queryKey });
        void queryClient.invalidateQueries({ queryKey: curatedQueries.runtimeMap().queryKey });
      },
      onError: () => {
        setCloseFeedback(t("board.close.failed"));
      },
    });
  }

  useEffect(() => {
    if (data?.state.diagnosis === "ready" && rerunFeedback) {
      setRerunFeedback(null);
    }
  }, [data?.state.diagnosis, rerunFeedback]);

  if (isLoading) {
    return (
      <div className="lens-board-loading" role="status">
        {t("board.loading")}
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="lens-board-error" role="alert">
        {t("board.error")}
      </div>
    );
  }

  const confirmedNow = [
    t("board.confirmedNow.severity", { severity: data.severity.toUpperCase() }),
    data.blastRadius.length > 0
      ? t("board.confirmedNow.blastRadiusVisible", { count: data.blastRadius.length })
      : t("board.confirmedNow.blastRadiusReserved"),
    data.evidenceSummary.traces + data.evidenceSummary.metrics + data.evidenceSummary.logs > 0
      ? t("board.confirmedNow.evidenceAvailable", {
          traces: data.evidenceSummary.traces,
          metrics: data.evidenceSummary.metrics,
          logs: data.evidenceSummary.logs,
        })
      : t("board.confirmedNow.evidenceStudioOpen"),
  ];

  const notYetConfirmed = [
    t("board.notYetConfirmed.rootCause"),
    t("board.notYetConfirmed.dependency"),
    t("board.notYetConfirmed.confidence"),
  ];

  const nextSteps = [
    t("board.nextSteps.openEvidence"),
    t("board.nextSteps.useNextStep"),
    t("board.nextSteps.reserveRerun"),
  ];

  const hasDiagnosisGap = data.state.diagnosis !== "ready";
  const rerunAcknowledged =
    rerunFeedback === t("board.rerun.requested")
    || rerunFeedback === t("board.rerun.alreadyRunning");
  const rerunDisabled =
    rerunDiagnosis.isPending || rerunAcknowledged || data.state.diagnosis === "pending";
  const rerunLabel = rerunDiagnosis.isPending ? t("board.rerun.startingLabel") : t("board.rerun.label");
  const pendingMessage =
    rerunDiagnosis.isPending || rerunFeedback === t("board.rerun.requested")
      ? t("board.rerun.inProgress")
      : t("board.rerun.assembling");
  const rerunNote = rerunFeedback ?? (
    data.state.diagnosis === "pending"
      ? t("board.rerun.alreadyRunningNote")
      : t("board.rerun.defaultNote")
  );

  return (
    <div className="lens-board-content stagger">
      {/* 1. Identity + confidence badge */}
      <WhatHappened
        incidentId={data.incidentId}
        status={data.status}
        closedAt={data.closedAt}
        severity={data.severity}
        headline={data.headline}
        chips={data.chips}
        state={data.state}
        confidence={data.confidenceSummary}
      />

      <div className="lens-board-operator-actions">
        {closeConfirm ? (
          <div className="lens-board-close-confirm" role="alertdialog" aria-label={t("board.close.confirmTitle")}>
            <p className="lens-board-close-confirm-msg">{t("board.close.confirmMessage", { id: data.incidentId })}</p>
            <div className="lens-board-close-confirm-btns">
              <button type="button" className="ui-btn ui-btn-outline ui-btn-sz-sm" onClick={() => setCloseConfirm(false)}>
                {t("board.close.cancel")}
              </button>
              <button type="button" className="ui-btn ui-btn-destructive ui-btn-sz-sm" onClick={() => { setCloseConfirm(false); handleCloseIncident(); }}>
                {t("board.close.confirm")}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="lens-board-btn-close"
            onClick={() => setCloseConfirm(true)}
            disabled={closeIncident.isPending || data.status === "closed"}
            aria-label={data.status === "closed" ? t("board.close.closedLabel") : t("board.close.button")}
          >
            {closeIncident.isPending
              ? t("board.close.closing")
              : data.status === "closed"
                ? t("board.close.closedLabel")
                : t("board.close.button")}
          </button>
        )}
        {closeFeedback ? <p className="lens-board-close-note">{closeFeedback}</p> : null}
      </div>

      {hasDiagnosisGap ? (
        <DiagnosisPending
          status={data.state.diagnosis === "pending" ? "pending" : "unavailable"}
          message={
            data.state.diagnosis === "pending"
              ? pendingMessage
              : t("board.rerun.unavailable")
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

      {/* 2. Immediate Action — full width hero */}
      <ImmediateAction action={data.action} state={data.state} />

      {/* 3. Operator Check — directly below action */}
      <OperatorCheck checks={data.operatorChecks} state={data.state} />

      {/* 4. Causal Chain */}
      <CauseCard steps={data.causalChain} state={data.state} />

      {/* 5. Root Cause Hypothesis + confidence details */}
      <RootCauseHypothesis
        hypothesis={data.rootCauseHypothesis}
        state={data.state}
        confidence={data.confidenceSummary}
      />

      {/* 6. Evidence — thin status bar */}
      <LensEvidenceEntry
        counts={data.evidenceSummary}
        impact={data.impactSummary}
        state={data.state}
        zoomTo={zoomTo}
      />
    </div>
  );
}
