import { createRootRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "../components/shell/AppShell.js";

export const rootRoute = createRootRoute({
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});
