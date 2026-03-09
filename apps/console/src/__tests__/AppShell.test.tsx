import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "../components/shell/AppShell.js";
import { incidentQueries } from "../api/queries.js";
import { testIncident } from "./fixtures.js";
import type { Incident } from "../api/types.js";

// Mock router so we can control the current pathname
vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: "/incidents/inc_test_001" } }),
}));

// Lightweight stubs for shell sub-components
vi.mock("../components/shell/TopBar.js", () => ({
  TopBar: ({ incident }: { incident: Incident | undefined }) => (
    <div data-testid="top-bar" data-incident-id={incident?.incidentId ?? "none"} />
  ),
}));
vi.mock("../components/shell/LeftRail.js", () => ({
  LeftRail: () => <div data-testid="left-rail" />,
}));
vi.mock("../components/shell/RightRail.js", () => ({
  RightRail: ({ diagnosisResult }: { diagnosisResult: unknown }) => (
    <div data-testid="right-rail" data-has-diagnosis={diagnosisResult ? "true" : "false"} />
  ),
}));

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("AppShell — detail cache fallback (deep link)", () => {
  it("reads currentIncident from detail cache when list query is empty", () => {
    const queryClient = makeClient();
    // Simulate: list not yet loaded (items=[]), but detail already in cache
    queryClient.setQueryData(incidentQueries.list().queryKey, { items: [] });
    queryClient.setQueryData(
      incidentQueries.detail("inc_test_001").queryKey,
      testIncident,
    );

    render(
      <QueryClientProvider client={queryClient}>
        <AppShell>
          <div />
        </AppShell>
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("top-bar")).toHaveAttribute(
      "data-incident-id",
      "inc_test_001",
    );
    expect(screen.getByTestId("right-rail")).toHaveAttribute(
      "data-has-diagnosis",
      "true",
    );
  });

  it("falls back to undefined when both list and detail cache are cold", () => {
    const queryClient = makeClient();
    queryClient.setQueryData(incidentQueries.list().queryKey, { items: [] });
    // detail cache intentionally empty

    render(
      <QueryClientProvider client={queryClient}>
        <AppShell>
          <div />
        </AppShell>
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("top-bar")).toHaveAttribute("data-incident-id", "none");
    expect(screen.getByTestId("right-rail")).toHaveAttribute("data-has-diagnosis", "false");
  });
});
