import { lazy, Suspense, useEffect, useRef } from "react";
import { useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TopBar } from "./TopBar.js";
import { LeftRail } from "./LeftRail.js";
import { RightRail } from "./RightRail.js";
import { NormalSurface } from "./NormalSurface.js";
import { incidentQueries } from "../../api/queries.js";
import { buildIncidentWorkspaceVM } from "../../lib/viewmodels/index.js";
import type { Incident } from "../../api/types.js";

// Lazy-load IncidentBoard (ADR 0025 responsiveness-first)
const IncidentBoard = lazy(() =>
  import("../board/IncidentBoard.js").then((m) => ({ default: m.IncidentBoard })),
);

export function AppShell() {
  const { incidentId: currentIncidentId } = useSearch({ from: "__root__" });
  const mode: "normal" | "incident" = currentIncidentId ? "incident" : "normal";

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
  const incidents = page?.items ?? [];
  const listIncident = incidents.find((i) => i.incidentId === currentIncidentId);

  // Fall back to the detail query cache (already populated by the incident route) when the
  // list hasn't loaded yet — e.g. on a deep link or when list fetch fails after detail loads.
  const queryClient = useQueryClient();
  const cachedIncident =
    currentIncidentId && !listIncident
      ? queryClient.getQueryData<Incident>(incidentQueries.detail(currentIncidentId).queryKey)
      : undefined;
  const currentIncident = listIncident ?? cachedIncident;
  const copilotVM = currentIncident ? buildIncidentWorkspaceVM(currentIncident)?.copilot : undefined;

  return (
    <div className="app" data-mode={mode}>
      <TopBar incident={currentIncident} />
      <div className="main-grid">
        <LeftRail incidents={incidents} currentIncidentId={currentIncidentId} />
        <div
          ref={normalRef}
          tabIndex={-1}
          className="center-normal"
          aria-hidden={mode === "incident"}
          data-surface="normal"
        >
          <NormalSurface />
        </div>
        <div
          ref={incidentRef}
          tabIndex={-1}
          className="center-incident"
          aria-hidden={mode === "normal"}
          data-surface="incident"
        >
          <Suspense fallback={null}>
            {currentIncident && <IncidentBoard incident={currentIncident} />}
          </Suspense>
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
