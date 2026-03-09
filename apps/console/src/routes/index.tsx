import { createRoute, redirect } from "@tanstack/react-router";
import { rootRoute } from "./__root.js";
import { incidentQueries } from "../api/queries.js";
import type { QueryClient } from "@tanstack/react-query";

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: async ({ context }) => {
    const queryClient = (context as { queryClient: QueryClient }).queryClient;
    const page = await queryClient.fetchQuery(incidentQueries.list());
    if (page.items.length > 0) {
      throw redirect({ to: "/incidents/$incidentId", params: { incidentId: page.items[0]!.incidentId } });
    }
  },
  component: () => (
    <div className="empty-state">
      <p>No open incidents.</p>
    </div>
  ),
});
