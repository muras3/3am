import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./__root.js";

// "/" is the ambient normal surface. No auto-redirect to an incident —
// the user explicitly enters incident mode by selecting an incident or
// following a deep-link with ?incidentId=. (ADR: CSS transition shell)
export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => null,
});
