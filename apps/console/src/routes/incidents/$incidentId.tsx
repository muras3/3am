import { createRoute, redirect } from "@tanstack/react-router";
import { rootRoute } from "../__root.js";

// Compatibility redirect: /incidents/:incidentId → /?incidentId=:incidentId
// Preserves deep-link behaviour without a page navigation feel (ADR: CSS transition shell)
export const incidentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/incidents/$incidentId",
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/", search: { incidentId: params.incidentId, level: 0 as const, tab: "traces" as const } });
  },
  component: () => null,
});
