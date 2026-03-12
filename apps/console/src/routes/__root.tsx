import { createRootRouteWithContext } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { AppShell } from "../components/shell/AppShell.js";

export interface RouterContext {
  queryClient: QueryClient;
}

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  validateSearch: (search: Record<string, unknown>) => ({
    incidentId: typeof search["incidentId"] === "string" ? search["incidentId"] : undefined,
  }),
  component: () => <AppShell />,
});
