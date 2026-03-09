import { createRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { rootRoute } from "../__root.js";
import { incidentQueries } from "../../api/queries.js";
import { ApiError } from "../../api/client.js";
import { ErrorState } from "../../components/common/ErrorState.js";

// Lazy-load IncidentBoard (ADR 0025 responsiveness-first)
import { lazy, Suspense } from "react";
const IncidentBoard = lazy(() => import("../../components/board/IncidentBoard.js").then((m) => ({ default: m.IncidentBoard })));

function IncidentPage() {
  const { incidentId } = incidentRoute.useParams();
  const { data: incident } = useSuspenseQuery(incidentQueries.detail(incidentId));
  return (
    <Suspense fallback={<div className="loading">Loading...</div>}>
      <IncidentBoard incident={incident} />
    </Suspense>
  );
}

export const incidentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/incidents/$incidentId",
  errorComponent: ({ error }) => {
    if (error instanceof ApiError && error.status === 404) {
      return <ErrorState message="Incident not found." />;
    }
    return <ErrorState message={error.message} />;
  },
  component: IncidentPage,
});
