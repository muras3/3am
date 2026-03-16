import { lazy, Suspense, useEffect, useRef } from "react";
import { ErrorBoundary } from "../common/ErrorBoundary.js";
import { useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TopBar } from "./TopBar.js";
import { LeftRail } from "./LeftRail.js";
import { RightRail } from "./RightRail.js";
import { NormalSurface } from "./NormalSurface.js";
import { ErrorState } from "../common/ErrorState.js";
import { ApiError } from "../../api/client.js";
import { ambientQueries, incidentQueries } from "../../api/queries.js";
import { buildIncidentWorkspaceVM } from "../../lib/viewmodels/index.js";
import type { Incident } from "../../api/types.js";

// Lazy-load IncidentBoard (ADR 0025 responsiveness-first)
const IncidentBoard = lazy(() =>
  import("../board/IncidentBoard.js").then((m) => ({ default: m.IncidentBoard })),
);

export function AppShell() {
  const { incidentId: currentIncidentId } = useSearch({ from: "__root__" });
  const mode: "normal" | "incident" = currentIncidentId ? "incident" : "normal";
  const normalInactive = mode === "incident";
  const incidentInactive = mode === "normal";

  // Focus management: move focus to the newly visible surface on mode change.
  // tabIndex={-1} makes the divs programmatically focusable without entering tab order.
  const normalRef = useRef<HTMLDivElement>(null);
  const incidentRef = useRef<HTMLDivElement>(null);
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) { isFirstRender.current = false; return; }
    if (mode === "incident") incidentRef.current?.focus();
    else normalRef.current?.focus();
  }, [mode]);

  const { data: page } = useQuery({ ...incidentQueries.list(), throwOnError: false });
  const { data: services = [] } = useQuery({
    ...ambientQueries.services(),
    throwOnError: false,
  });
  const { data: activity = [] } = useQuery({
    ...ambientQueries.activity(12),
    throwOnError: false,
  });
  const incidents = page?.items ?? [];
  const listIncident = incidents.find((i) => i.incidentId === currentIncidentId);

  // Fall back to the detail query cache (already populated by the incident route) when the
  // list hasn't loaded yet — e.g. on a deep link or when list fetch fails after detail loads.
  const queryClient = useQueryClient();
  const cachedIncident =
    currentIncidentId && !listIncident
      ? queryClient.getQueryData<Incident>(incidentQueries.detail(currentIncidentId).queryKey)
      : undefined;
  const { data: detailIncident, error: detailError } = useQuery({
    ...incidentQueries.detail(currentIncidentId ?? ""),
    enabled: Boolean(currentIncidentId) && !listIncident && !cachedIncident,
    throwOnError: false,
    retry: false,
  });
  const currentIncident = detailIncident ?? listIncident ?? cachedIncident;
  const incidentError =
    detailError instanceof ApiError && detailError.status === 404
      ? "Incident not found."
      : detailError instanceof Error
        ? detailError.message
        : null;
  const copilotVM = currentIncident ? buildIncidentWorkspaceVM(currentIncident)?.copilot : undefined;

  return (
    <div className="app" data-mode={mode}>
      <TopBar incident={currentIncident} />
      <div className="main-grid">
        <LeftRail
          incidents={incidents}
          currentIncidentId={currentIncidentId}
          services={services}
        />
        <div
          ref={normalRef}
          tabIndex={-1}
          className="center-normal"
          aria-hidden={normalInactive}
          inert={normalInactive}
          data-surface="normal"
        >
          <NormalSurface services={services} activity={activity} incidents={incidents} />
        </div>
        <div
          ref={incidentRef}
          tabIndex={-1}
          className="center-incident"
          aria-hidden={incidentInactive}
          inert={incidentInactive}
          data-surface="incident"
        >
          <ErrorBoundary>
            <Suspense fallback={null}>
              {currentIncident
                ? <IncidentBoard incident={currentIncident} />
                : incidentError
                  ? <ErrorState message={incidentError} />
                  : null}
            </Suspense>
          </ErrorBoundary>
        </div>
        <RightRail
          incidentId={currentIncidentId ?? ""}
          diagnosisResult={currentIncident?.diagnosisResult}
          copilotVM={copilotVM}
        />
      </div>
    </div>
  );
}
