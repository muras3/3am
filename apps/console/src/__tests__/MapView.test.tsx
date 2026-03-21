import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MapView } from "../components/lens/map/MapView.js";
import { curatedQueries } from "../api/queries.js";
import { runtimeMapReady } from "../__fixtures__/curated/runtime-map.js";
import type { LensLevel } from "../routes/__root.js";

// ── Stub TanStack Router (MapView doesn't use it directly, but sub-components may) ──
vi.mock("@tanstack/react-router", () => ({
  useSearch: () => ({ level: 0, tab: "traces" }),
  useNavigate: () => vi.fn(),
}));

// ── Helpers ────────────────────────────────────────────────────

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderMapView(
  queryClient: QueryClient,
  zoomTo: (level: LensLevel, trigger?: HTMLElement) => void = vi.fn(),
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
    expect(screen.getByTestId("stat-degraded-nodes").textContent).toBe("2");
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

describe("MapView — map nodes", () => {
  it("renders correct number of map nodes (5 in ready fixture)", () => {
    const queryClient = makeClient();
    queryClient.setQueryData(curatedQueries.runtimeMap().queryKey, runtimeMapReady);

    renderMapView(queryClient);

    const nodes = document.querySelectorAll(".map-node");
    expect(nodes).toHaveLength(runtimeMapReady.nodes.length);
  });

  it("entry_point nodes have n-entry class", () => {
    const queryClient = makeClient();
    queryClient.setQueryData(curatedQueries.runtimeMap().queryKey, runtimeMapReady);

    renderMapView(queryClient);

    const entryNodes = document.querySelectorAll(".map-node.n-entry");
    const expectedCount = runtimeMapReady.nodes.filter((n) => n.tier === "entry_point").length;
    expect(entryNodes).toHaveLength(expectedCount);
  });

  it("runtime_unit nodes have n-unit class", () => {
    const queryClient = makeClient();
    queryClient.setQueryData(curatedQueries.runtimeMap().queryKey, runtimeMapReady);

    renderMapView(queryClient);

    const unitNodes = document.querySelectorAll(".map-node.n-unit");
    const expectedCount = runtimeMapReady.nodes.filter((n) => n.tier === "runtime_unit").length;
    expect(unitNodes).toHaveLength(expectedCount);
  });

  it("dependency nodes have n-dep class", () => {
    const queryClient = makeClient();
    queryClient.setQueryData(curatedQueries.runtimeMap().queryKey, runtimeMapReady);

    renderMapView(queryClient);

    const depNodes = document.querySelectorAll(".map-node.n-dep");
    const expectedCount = runtimeMapReady.nodes.filter((n) => n.tier === "dependency").length;
    expect(depNodes).toHaveLength(expectedCount);
  });

  it("critical nodes have n-critical class", () => {
    const queryClient = makeClient();
    queryClient.setQueryData(curatedQueries.runtimeMap().queryKey, runtimeMapReady);

    renderMapView(queryClient);

    const criticalNodes = document.querySelectorAll(".map-node.n-critical");
    const expectedCount = runtimeMapReady.nodes.filter((n) => n.status === "critical").length;
    expect(criticalNodes).toHaveLength(expectedCount);
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
});

describe("MapView — keyboard navigation", () => {
  it("pressing Enter on a clickable node triggers zoomTo(1)", () => {
    const zoomTo = vi.fn();
    const queryClient = makeClient();
    queryClient.setQueryData(curatedQueries.runtimeMap().queryKey, runtimeMapReady);

    renderMapView(queryClient, zoomTo);

    // Find a node with incidentId (clickable)
    const clickableNode = runtimeMapReady.nodes.find((n) => !!n.incidentId);
    expect(clickableNode).toBeDefined();
    const nodeEl = screen.getByTestId(`map-node-${clickableNode!.id}`);

    fireEvent.keyDown(nodeEl, { key: "Enter" });

    expect(zoomTo).toHaveBeenCalledWith(1, expect.any(HTMLElement));
  });

  it("pressing Space on a clickable node triggers zoomTo(1)", () => {
    const zoomTo = vi.fn();
    const queryClient = makeClient();
    queryClient.setQueryData(curatedQueries.runtimeMap().queryKey, runtimeMapReady);

    renderMapView(queryClient, zoomTo);

    const clickableNode = runtimeMapReady.nodes.find((n) => !!n.incidentId);
    expect(clickableNode).toBeDefined();
    const nodeEl = screen.getByTestId(`map-node-${clickableNode!.id}`);

    fireEvent.keyDown(nodeEl, { key: " " });

    expect(zoomTo).toHaveBeenCalledWith(1, expect.any(HTMLElement));
  });

  it("pressing Enter on an incident row triggers zoomTo(1)", () => {
    const zoomTo = vi.fn();
    const queryClient = makeClient();
    queryClient.setQueryData(curatedQueries.runtimeMap().queryKey, runtimeMapReady);

    renderMapView(queryClient, zoomTo);

    const firstIncident = runtimeMapReady.incidents[0]!;
    const rowEl = screen.getByTestId(`incident-row-${firstIncident.incidentId}`);

    fireEvent.keyDown(rowEl, { key: "Enter" });

    expect(zoomTo).toHaveBeenCalledWith(1, expect.any(HTMLElement));
  });

  it("clicking an incident row triggers zoomTo(1)", () => {
    const zoomTo = vi.fn();
    const queryClient = makeClient();
    queryClient.setQueryData(curatedQueries.runtimeMap().queryKey, runtimeMapReady);

    renderMapView(queryClient, zoomTo);

    const firstIncident = runtimeMapReady.incidents[0]!;
    const rowEl = screen.getByTestId(`incident-row-${firstIncident.incidentId}`);

    fireEvent.click(rowEl);

    expect(zoomTo).toHaveBeenCalledWith(1, expect.any(HTMLElement));
  });
});

describe("MapView — loading / error states", () => {
  it("shows loading state when data is not yet available", () => {
    const queryClient = makeClient();
    // Don't set query data — will be in loading state
    renderMapView(queryClient);

    expect(screen.getByText("Loading map…")).toBeInTheDocument();
  });
});

describe("MapView — tab order", () => {
  it("all map nodes have tabIndex 0", () => {
    const queryClient = makeClient();
    queryClient.setQueryData(curatedQueries.runtimeMap().queryKey, runtimeMapReady);

    renderMapView(queryClient);

    const nodes = document.querySelectorAll(".map-node");
    nodes.forEach((node) => {
      expect(node.getAttribute("tabindex")).toBe("0");
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
