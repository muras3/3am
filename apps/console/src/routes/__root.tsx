import { createRootRouteWithContext } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { AppShell } from "../components/shell/AppShell.js";
import { parseIncidentId } from "../lib/incidentId.js";

export interface RouterContext {
  queryClient: QueryClient;
}

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  validateSearch: (search: Record<string, unknown>) => ({
    incidentId: parseIncidentId(search["incidentId"]),
  }),
  component: () => <AppShell />,
});
