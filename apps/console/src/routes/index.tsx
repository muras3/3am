import { createRoute, redirect } from "@tanstack/react-router";
import { rootRoute } from "./__root.js";
import { incidentQueries } from "../api/queries.js";

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: async ({ context, search }) => {
    if (!search.incidentId) {
      const page = await context.queryClient.fetchQuery(incidentQueries.list());
      if (page.items.length > 0) {
        throw redirect({ to: "/", search: { incidentId: page.items[0]!.incidentId } });
      }
    }
  },
  component: () => null,
});
