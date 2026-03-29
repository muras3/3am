import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MapView } from "../components/lens/map/MapView.js";
import { curatedQueries } from "../api/queries.js";
import {
  runtimeMapIncidentFallback,
  runtimeMapReady,
  runtimeMapSparse,
  runtimeMapUnavailable,
} from "../__fixtures__/curated/runtime-map.js";
import type { LensLevel } from "../routes/__root.js";

// ── Stub TanStack Router (MapView doesn't use it directly, but sub-components may) ──
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  useSearch: () => ({ level: 0, tab: "traces" }),
  useNavigate: () => vi.fn(),
}));

// ── Helpers ────────────────────────────────────────────────────

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderMapView(
  queryClient: QueryClient,
  zoomTo: (level: LensLevel, trigger?: HTMLElement, incidentId?: string) => void = vi.fn(),
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MapView zoomTo={zoomTo} />
    </QueryClientProvider>,
  );
}

// ── Tests ──────────────────────────────────────────────────────

describe("MapView — stats bar", () => {
  it("renders stats bar with correct values from fixture", () => {
    const queryClient = makeClient();
    queryClient.setQueryData(curatedQueries.runtimeMap().queryKey, runtimeMapReady);

    renderMapView(queryClient);

    expect(screen.getByTestId("stat-active-incidents").textContent).toBe("2");
    expect(screen.getByTestId("stat-degraded-services").textContent).toBe("1");
    expect(screen.getByTestId("stat-req-per-sec").textContent).toBe("866");
    expect(screen.getByTestId("stat-p95").textContent).toBe("89ms");
  });

  it("renders stats bar component itself", () => {
    const queryClient = makeClient();
    queryClient.setQueryData(curatedQueries.runtimeMap().queryKey, runtimeMapReady);

    renderMapView(queryClient);

    expect(screen.getByTestId("stats-bar")).toBeInTheDocument();
  });
});

describe("MapView — service cards", () => {
  it("renders correct number of service cards", () => {
    const queryClient = makeClient();
    queryClient.setQueryData(curatedQueries.runtimeMap().queryKey, runtimeMapReady);

    renderMapView(queryClient);

    const serviceCards = document.querySelectorAll(".svc-card");
    expect(serviceCards).toHaveLength(runtimeMapReady.services.length);
  });

  it("critical service card has has-error class", () => {
    const queryClient = makeClient();
    queryClient.setQueryData(curatedQueries.runtimeMap().queryKey, runtimeMapReady);

    renderMapView(queryClient);

    const errorCards = document.querySelectorAll(".svc-card.has-error");
    const expectedCount = runtimeMapReady.services.filter((s) => s.status === "critical").length;
    expect(errorCards).toHaveLength(expectedCount);
  });

  it("renders route rows within service cards", () => {
    const queryClient = makeClient();
    queryClient.setQueryData(curatedQueries.runtimeMap().queryKey, runtimeMapReady);

    renderMapView(queryClient);

    const routeRows = document.querySelectorAll(".route-row");
    const totalRoutes = runtimeMapReady.services.reduce((sum, svc) => sum + svc.routes.length, 0);
    expect(routeRows).toHaveLength(totalRoutes);
  });

  it("critical routes have is-critical class", () => {
    const queryClient = makeClient();
    queryClient.setQueryData(curatedQueries.runtimeMap().queryKey, runtimeMapReady);

    renderMapView(queryClient);

    const criticalRoutes = document.querySelectorAll(".route-row.is-critical");
    const totalCritical = runtimeMapReady.services.reduce(
      (sum, svc) => sum + svc.routes.filter((r) => r.status === "critical").length,
      0,
    );
    expect(criticalRoutes).toHaveLength(totalCritical);
  });
});

describe("MapView — dependency cards", () => {
  it("renders correct number of dependency cards", () => {
    const queryClient = makeClient();
    queryClient.setQueryData(curatedQueries.runtimeMap().queryKey, runtimeMapReady);

    renderMapView(queryClient);

    const depCards = document.querySelectorAll(".dep-card");
    expect(depCards).toHaveLength(runtimeMapReady.dependencies.length);
  });

  it("critical dependency cards have has-error class", () => {
    const queryClient = makeClient();
    queryClient.setQueryData(curatedQueries.runtimeMap().queryKey, runtimeMapReady);

    renderMapView(queryClient);

    const errorDeps = document.querySelectorAll(".dep-card.has-error");
    const expectedCount = runtimeMapReady.dependencies.filter((d) => d.status === "critical").length;
    expect(errorDeps).toHaveLength(expectedCount);
  });
});

describe("MapView — incident strip", () => {
  it("renders incident strip rows for each incident", () => {
    const queryClient = makeClient();
    queryClient.setQueryData(curatedQueries.runtimeMap().queryKey, runtimeMapReady);

    renderMapView(queryClient);

    const rows = document.querySelectorAll(".incident-row");
    expect(rows).toHaveLength(runtimeMapReady.incidents.length);
  });

  it("renders incident labels", () => {
    const queryClient = makeClient();
    queryClient.setQueryData(curatedQueries.runtimeMap().queryKey, runtimeMapReady);

    renderMapView(queryClient);

    expect(screen.getByText("Stripe Rate Limit Cascade")).toBeInTheDocument();
  });

  it("keeps active incidents shell visible when there are no incidents", () => {
    const queryClient = makeClient();
    queryClient.setQueryData(curatedQueries.runtimeMap().queryKey, runtimeMapSparse);

    renderMapView(queryClient);

    expect(screen.getAllByText("Active Incidents").length).toBeGreaterThan(1);
    expect(screen.getByTestId("incident-strip")).toBeInTheDocument();
    expect(screen.getByTestId("incident-row-empty")).toBeInTheDocument();
  });
});

describe("MapView — empty map shell", () => {
  it("shows empty state and legend when no services are returned", () => {
    const queryClient = makeClient();
    queryClient.setQueryData(curatedQueries.runtimeMap().queryKey, runtimeMapUnavailable);

    renderMapView(queryClient);

    expect(screen.getByLabelText("Runtime dependency map")).toBeInTheDocument();
    expect(screen.getByTestId("map-empty-state")).toHaveTextContent("No recent spans in the live window.");
    expect(screen.getByTestId("map-empty-state")).toHaveTextContent("2 open incidents");
  });

  it("surfaces incident-scoped fallback clearly when preserved spans are available", () => {
    const queryClient = makeClient();
    queryClient.setQueryData(curatedQueries.runtimeMap().queryKey, runtimeMapIncidentFallback);

    renderMapView(queryClient);

    expect(screen.getByTestId("map-status-banner")).toHaveTextContent("Live window empty");
    expect(screen.getByTestId("map-status-banner")).toHaveTextContent("captured incident window");
    expect(document.querySelectorAll(".svc-card")).toHaveLength(runtimeMapIncidentFallback.services.length);
    expect(document.querySelectorAll(".dep-card")).toHaveLength(runtimeMapIncidentFallback.dependencies.length);
  });
});

describe("MapView — keyboard navigation", () => {
  it("pressing Enter on a clickable route row triggers zoomTo(1)", () => {
    const zoomTo = vi.fn();
    const queryClient = makeClient();
    queryClient.setQueryData(curatedQueries.runtimeMap().queryKey, runtimeMapReady);

    renderMapView(queryClient, zoomTo);

    // Find a route with incidentId (clickable)
    const clickableRoute = runtimeMapReady.services
      .flatMap((s) => s.routes)
      .find((r) => !!r.incidentId);
    expect(clickableRoute).toBeDefined();
    const routeEl = screen.getByTestId(`route-row-${clickableRoute!.id}`);

    fireEvent.keyDown(routeEl, { key: "Enter" });

    expect(zoomTo).toHaveBeenCalledWith(1, expect.any(HTMLElement), clickableRoute!.incidentId);
  });

  it("pressing Space on a clickable route row triggers zoomTo(1)", () => {
    const zoomTo = vi.fn();
    const queryClient = makeClient();
    queryClient.setQueryData(curatedQueries.runtimeMap().queryKey, runtimeMapReady);

    renderMapView(queryClient, zoomTo);

    const clickableRoute = runtimeMapReady.services
      .flatMap((s) => s.routes)
      .find((r) => !!r.incidentId);
    expect(clickableRoute).toBeDefined();
    const routeEl = screen.getByTestId(`route-row-${clickableRoute!.id}`);

    fireEvent.keyDown(routeEl, { key: " " });

    expect(zoomTo).toHaveBeenCalledWith(1, expect.any(HTMLElement), clickableRoute!.incidentId);
  });

  it("pressing Enter on an incident row triggers zoomTo(1)", () => {
    const zoomTo = vi.fn();
    const queryClient = makeClient();
    queryClient.setQueryData(curatedQueries.runtimeMap().queryKey, runtimeMapReady);

    renderMapView(queryClient, zoomTo);

    const firstIncident = runtimeMapReady.incidents[0]!;
    const rowEl = screen.getByTestId(`incident-row-${firstIncident.incidentId}`);

    fireEvent.keyDown(rowEl, { key: "Enter" });

    expect(zoomTo).toHaveBeenCalledWith(1, expect.any(HTMLElement), firstIncident.incidentId);
  });

  it("clicking an incident row triggers zoomTo(1)", () => {
    const zoomTo = vi.fn();
    const queryClient = makeClient();
    queryClient.setQueryData(curatedQueries.runtimeMap().queryKey, runtimeMapReady);

    renderMapView(queryClient, zoomTo);

    const firstIncident = runtimeMapReady.incidents[0]!;
    const rowEl = screen.getByTestId(`incident-row-${firstIncident.incidentId}`);

    fireEvent.click(rowEl);

    expect(zoomTo).toHaveBeenCalledWith(1, expect.any(HTMLElement), firstIncident.incidentId);
  });
});

describe("MapView — loading / error states", () => {
  it("shows loading state when data is not yet available", () => {
    const queryClient = makeClient();
    // Don't set query data — will be in loading state
    renderMapView(queryClient);

    expect(screen.getByText("Loading map\u2026")).toBeInTheDocument();
  });
});

describe("MapView — tab order", () => {
  it("clickable route rows have tabIndex 0", () => {
    const queryClient = makeClient();
    queryClient.setQueryData(curatedQueries.runtimeMap().queryKey, runtimeMapReady);

    renderMapView(queryClient);

    const clickableRoutes = document.querySelectorAll(".route-row.clickable");
    clickableRoutes.forEach((row) => {
      expect(row.getAttribute("tabindex")).toBe("0");
    });
  });

  it("all incident rows have tabIndex 0", () => {
    const queryClient = makeClient();
    queryClient.setQueryData(curatedQueries.runtimeMap().queryKey, runtimeMapReady);

    renderMapView(queryClient);

    const rows = document.querySelectorAll(".incident-row");
    rows.forEach((row) => {
      expect(row.getAttribute("tabindex")).toBe("0");
    });
  });
});
