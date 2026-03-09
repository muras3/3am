import { createRouter } from "@tanstack/react-router";
import { rootRoute } from "./routes/__root.js";
import { indexRoute } from "./routes/index.js";
import { incidentRoute } from "./routes/incidents/$incidentId.js";

const routeTree = rootRoute.addChildren([indexRoute, incidentRoute]);

// context is provided at runtime by <RouterProvider context={{ queryClient }} /> in main.tsx
export const router = createRouter({ routeTree, context: { queryClient: undefined! } });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
