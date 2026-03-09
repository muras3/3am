import type { ReactNode } from "react";
import { TopBar } from "./TopBar.js";
import { LeftRail } from "./LeftRail.js";
import { RightRail } from "./RightRail.js";
import { useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { incidentQueries } from "../../api/queries.js";
import type { Incident } from "../../api/types.js";

export function AppShell({ children }: { children: ReactNode }) {
  // Extract incidentId from the URL path — more stable than reading routerState.matches.at(-1)
  // which would break if a nested route is added between the root and incidents/$incidentId.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const currentIncidentId = pathname.match(/^\/incidents\/([^/]+)/)?.[1];

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

  return (
    <div className="app">
      <TopBar incident={currentIncident} />
      <div className="main-grid">
        <LeftRail incidents={incidents} currentIncidentId={currentIncidentId} />
        <main className="center-board">{children}</main>
        <RightRail
          incidentId={currentIncidentId ?? ""}
          diagnosisResult={currentIncident?.diagnosisResult}
        />
      </div>
    </div>
  );
}
