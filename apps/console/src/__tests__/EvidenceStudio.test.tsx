import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EvidenceStudio } from "../components/evidence/EvidenceStudio.js";
import { testIncident } from "./fixtures.js";

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe("EvidenceStudio", () => {
  it("renders the Evidence Studio header", () => {
    render(
      <EvidenceStudio incident={testIncident} onClose={vi.fn()} />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByText("Evidence Studio")).toBeInTheDocument();
    expect(screen.getByText("web")).toBeInTheDocument();
  });

  it("renders Close button", () => {
    render(
      <EvidenceStudio incident={testIncident} onClose={vi.fn()} />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByText("Close")).toBeInTheDocument();
  });

  it("calls onClose when Close button clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <EvidenceStudio incident={testIncident} onClose={onClose} />,
      { wrapper: createWrapper() },
    );
    await user.click(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when ESC key pressed", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <EvidenceStudio incident={testIncident} onClose={onClose} />,
      { wrapper: createWrapper() },
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders 4-row grid layout (.es-app)", () => {
    const { container } = render(
      <EvidenceStudio incident={testIncident} onClose={vi.fn()} />,
      { wrapper: createWrapper() },
    );
    expect(container.querySelector(".es-app")).toBeInTheDocument();
    expect(container.querySelector(".es-header")).toBeInTheDocument();
    expect(container.querySelector(".es-tabs")).toBeInTheDocument();
    expect(container.querySelector(".es-content")).toBeInTheDocument();
  });

  it("renders EvidenceTabs with all 4 tabs", () => {
    render(
      <EvidenceStudio incident={testIncident} onClose={vi.fn()} />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByText("Traces")).toBeInTheDocument();
    expect(screen.getByText("Metrics")).toBeInTheDocument();
    expect(screen.getByText("Logs")).toBeInTheDocument();
    expect(screen.getByText("Platform")).toBeInTheDocument();
  });

  it("switches tab when Metrics is clicked", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <EvidenceStudio incident={testIncident} onClose={vi.fn()} />,
      { wrapper: createWrapper() },
    );
    await user.click(screen.getByText("Metrics"));
    const activeTab = container.querySelector(".es-tab.active");
    expect(activeTab?.textContent).toContain("Metrics");
  });

  it("shows proof cards skeleton while loading", () => {
    render(
      <EvidenceStudio incident={testIncident} onClose={vi.fn()} />,
      { wrapper: createWrapper() },
    );
    // Query is loading (no mock server), skeleton or proof-cards should appear
    const proofCards = screen.queryByTestId("proof-cards");
    const skeleton = screen.queryByTestId("proof-cards-skeleton");
    expect(proofCards || skeleton).toBeTruthy();
  });

  it("renders proof cards with data when telemetry queries resolve", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    // Pre-populate telemetry caches
    queryClient.setQueryData(
      ["incidents", testIncident.incidentId, "telemetry", "spans"],
      [],
    );
    queryClient.setQueryData(
      ["incidents", testIncident.incidentId, "telemetry", "metrics"],
      [],
    );
    queryClient.setQueryData(
      ["incidents", testIncident.incidentId, "telemetry", "logs"],
      { correlated: [], contextual: [] },
    );

    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <EvidenceStudio incident={testIncident} onClose={vi.fn()} />
        </QueryClientProvider>,
      );
    });

    expect(screen.getByTestId("proof-cards")).toBeInTheDocument();
    expect(screen.getAllByTestId("proof-card")).toHaveLength(3);
  });
});
