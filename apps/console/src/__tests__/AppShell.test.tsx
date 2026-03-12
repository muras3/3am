import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "../components/shell/AppShell.js";
import { ambientQueries, incidentQueries } from "../api/queries.js";
import { testIncident } from "./fixtures.js";
import type { Incident } from "../api/types.js";

// Mock router so we can control the current search params.
// incidentId = "inc_test_001" simulates deep-linking to an incident.
vi.mock("@tanstack/react-router", () => ({
  useSearch: () => ({ incidentId: "inc_test_001" }),
  Link: ({ children, ...rest }: { children: React.ReactNode; [k: string]: unknown }) => (
    <a {...(rest as React.AnchorHTMLAttributes<HTMLAnchorElement>)}>{children}</a>
  ),
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
vi.mock("../components/shell/NormalSurface.js", () => ({
  NormalSurface: () => <div data-testid="normal-surface" />,
}));
// IncidentBoard is lazy-loaded via React.lazy in AppShell — stub the module
vi.mock("../components/board/IncidentBoard.js", () => ({
  IncidentBoard: () => <div data-testid="incident-board" />,
}));

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AppShell — detail cache fallback (deep link)", () => {
  it("reads currentIncident from detail cache when list query is empty", () => {
    const queryClient = makeClient();
    // Simulate: list not yet loaded (items=[]), but detail already in cache
    queryClient.setQueryData(incidentQueries.list().queryKey, { items: [] });
    queryClient.setQueryData(incidentQueries.detail("inc_test_001").queryKey, testIncident);
    queryClient.setQueryData(ambientQueries.services().queryKey, []);
    queryClient.setQueryData(ambientQueries.activity(12).queryKey, []);

    render(
      <QueryClientProvider client={queryClient}>
        <AppShell />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("top-bar")).toHaveAttribute("data-incident-id", "inc_test_001");
    expect(screen.getByTestId("right-rail")).toHaveAttribute("data-has-diagnosis", "true");
  });

  it("shows an explicit not-found state when the deep-linked incident 404s", async () => {
    const queryClient = makeClient();
    queryClient.setQueryData(incidentQueries.list().queryKey, { items: [] });
    queryClient.setQueryData(ambientQueries.services().queryKey, []);
    queryClient.setQueryData(ambientQueries.activity(12).queryKey, []);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("missing", { status: 404 })),
    );

    render(
      <QueryClientProvider client={queryClient}>
        <AppShell />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Incident not found.")).toBeInTheDocument();
    expect(screen.getByTestId("top-bar")).toHaveAttribute("data-incident-id", "none");
    expect(screen.getByTestId("right-rail")).toHaveAttribute("data-has-diagnosis", "false");
  });
});
