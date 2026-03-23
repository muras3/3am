import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LensIncidentBoard } from "../components/lens/board/LensIncidentBoard.js";
import { curatedQueries } from "../api/queries.js";
import {
  extendedIncidentReady,
  extendedIncidentPending,
  extendedIncidentSparse,
} from "../__fixtures__/curated/extended-incident.js";
import type { LensLevel } from "../routes/__root.js";

// ── Helpers ───────────────────────────────────────────────────

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderBoard(
  incidentId: string,
  zoomTo: (l: LensLevel, el?: HTMLElement) => void,
  queryClient: QueryClient,
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <LensIncidentBoard incidentId={incidentId} zoomTo={zoomTo} />
    </QueryClientProvider>,
  );
}

function getPendingBanner() {
  return document.querySelector(".lens-board-pending");
}

// ── Tests ─────────────────────────────────────────────────────

describe("LensIncidentBoard — diagnosis pending", () => {
  it("renders a degraded-state banner with present and future sections", () => {
    const qc = makeClient();
    qc.setQueryData(
      curatedQueries.extendedIncident("inc_0892").queryKey,
      extendedIncidentPending,
    );
    renderBoard("inc_0892", vi.fn(), qc);
    const banner = getPendingBanner();
    expect(banner).not.toBeNull();
    expect(document.querySelectorAll(".lens-board-pending-panel")).toHaveLength(2);
    expect(document.querySelectorAll(".lens-board-pending-list li")).toHaveLength(6);
  });

  it("keeps board structure rendered while diagnosis is pending", () => {
    const qc = makeClient();
    qc.setQueryData(
      curatedQueries.extendedIncident("inc_0892").queryKey,
      extendedIncidentPending,
    );
    renderBoard("inc_0892", vi.fn(), qc);
    expect(document.querySelector(".lens-board-action-hero")).not.toBeNull();
    expect(document.querySelectorAll(".lens-board-blast-row")).toHaveLength(2);
    expect(document.querySelector(".lens-board-chain-placeholder")).not.toBeNull();
    expect(document.querySelector(".lens-board-evidence-note")).not.toBeNull();
  });
});

describe("LensIncidentBoard — diagnosis ready", () => {
  function setupReady() {
    const qc = makeClient();
    qc.setQueryData(
      curatedQueries.extendedIncident("inc_0892").queryKey,
      extendedIncidentReady,
    );
    return qc;
  }

  it("renders the incident headline", () => {
    renderBoard("inc_0892", vi.fn(), setupReady());
    expect(
      screen.getByText(/Stripe API rate limit cascade causing payment failures/),
    ).toBeInTheDocument();
    expect(screen.getAllByText("INC-0892").length).toBeGreaterThan(0);
  });

  it("renders Immediate Action section", () => {
    renderBoard("inc_0892", vi.fn(), setupReady());
    expect(screen.getByText("Immediate Action")).toBeInTheDocument();
    expect(
      screen.getByText(/Enable request batching on StripeClient/),
    ).toBeInTheDocument();
  });

  it("renders Do not block", () => {
    renderBoard("inc_0892", vi.fn(), setupReady());
    expect(
      screen.getByText(/Request a Stripe rate limit increase/),
    ).toBeInTheDocument();
  });

  it("renders Root Cause Hypothesis section", () => {
    renderBoard("inc_0892", vi.fn(), setupReady());
    expect(screen.getByText("Root Cause Hypothesis")).toBeInTheDocument();
    expect(
      screen.getByText(/StripeClient service makes unbatched 1:1 API calls/),
    ).toBeInTheDocument();
  });

  it("renders Causal Chain section", () => {
    renderBoard("inc_0892", vi.fn(), setupReady());
    expect(screen.getByText("Causal Chain")).toBeInTheDocument();
    // Check individual step tags from fixture
    expect(screen.getByText("External Trigger")).toBeInTheDocument();
    expect(screen.getByText("Design Gap")).toBeInTheDocument();
    expect(screen.getByText("Cascade")).toBeInTheDocument();
    expect(screen.getByText("User Impact")).toBeInTheDocument();
  });
});

describe("BlastRadius", () => {
  it("shows correct number of rows", () => {
    const qc = makeClient();
    qc.setQueryData(
      curatedQueries.extendedIncident("inc_0892").queryKey,
      extendedIncidentReady,
    );
    renderBoard("inc_0892", vi.fn(), qc);
    // fixture has 3 blast radius entries
    const rows = document.querySelectorAll(".lens-board-blast-row");
    expect(rows).toHaveLength(extendedIncidentReady.blastRadius.length);
  });

  it("shows blast target names", () => {
    const qc = makeClient();
    qc.setQueryData(
      curatedQueries.extendedIncident("inc_0892").queryKey,
      extendedIncidentReady,
    );
    renderBoard("inc_0892", vi.fn(), qc);
    expect(screen.getByText("payment-service")).toBeInTheDocument();
    expect(screen.getByText("order-service")).toBeInTheDocument();
    expect(screen.getByText("4 other services")).toBeInTheDocument();
  });
});

describe("ConfidenceCard", () => {
  it("displays confidence score value", () => {
    const qc = makeClient();
    qc.setQueryData(
      curatedQueries.extendedIncident("inc_0892").queryKey,
      extendedIncidentReady,
    );
    renderBoard("inc_0892", vi.fn(), qc);
    // fixture confidence.value = 0.85 → 85%
    expect(screen.getByText("85%")).toBeInTheDocument();
  });

  it("displays confidence label and basis", () => {
    const qc = makeClient();
    qc.setQueryData(
      curatedQueries.extendedIncident("inc_0892").queryKey,
      extendedIncidentReady,
    );
    renderBoard("inc_0892", vi.fn(), qc);
    expect(screen.getByText("High confidence")).toBeInTheDocument();
    expect(screen.getByText("Stripe 429 ↔ traffic r=0.97")).toBeInTheDocument();
  });
});

describe("OperatorCheck", () => {
  it("renders checkbox items from operatorChecks", () => {
    const qc = makeClient();
    qc.setQueryData(
      curatedQueries.extendedIncident("inc_0892").queryKey,
      extendedIncidentReady,
    );
    renderBoard("inc_0892", vi.fn(), qc);
    const checkboxes = document.querySelectorAll(".lens-board-checkbox");
    expect(checkboxes).toHaveLength(extendedIncidentReady.operatorChecks.length);
  });

  it("renders operator check text items", () => {
    const qc = makeClient();
    qc.setQueryData(
      curatedQueries.extendedIncident("inc_0892").queryKey,
      extendedIncidentReady,
    );
    renderBoard("inc_0892", vi.fn(), qc);
    expect(
      screen.getByText("Verify Stripe dashboard shows rate limit exceeded"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Check if batching config exists but is disabled"),
    ).toBeInTheDocument();
  });
});

describe("LensEvidenceEntry", () => {
  function setupReady() {
    const qc = makeClient();
    qc.setQueryData(
      curatedQueries.extendedIncident("inc_0892").queryKey,
      extendedIncidentReady,
    );
    return qc;
  }

  it("shows key timestamps", () => {
    renderBoard("inc_0892", vi.fn(), setupReady());
    // fixture impactSummary timestamps — use getAllBy since startedAt also appears in chain step
    expect(screen.getAllByText(/14:23:15 UTC/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/14:25:30 UTC/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/14:27:45 UTC/).length).toBeGreaterThan(0);
    // Verify timestamp spans are present in the evidence section specifically
    const timestamps = document.querySelectorAll(".lens-board-evidence-timestamps span");
    expect(timestamps).toHaveLength(3);
  });

  it("shows evidence counts", () => {
    renderBoard("inc_0892", vi.fn(), setupReady());
    // traces: 47, traceErrors: 12
    expect(screen.getByText(/47/)).toBeInTheDocument();
    expect(screen.getByText(/12 errors/)).toBeInTheDocument();
    // logs: 234, logErrors: 89
    expect(screen.getByText(/234/)).toBeInTheDocument();
    expect(screen.getByText(/89 errors/)).toBeInTheDocument();
  });

  it("calls zoomTo(2) when Open Evidence Studio button is clicked", () => {
    const zoomTo = vi.fn();
    renderBoard("inc_0892", zoomTo, setupReady());
    const btn = screen.getByRole("button", { name: /Open Evidence Studio/ });
    fireEvent.click(btn);
    expect(zoomTo).toHaveBeenCalledWith(2, expect.anything());
  });

  it("calls zoomTo(2) on Enter key", () => {
    const zoomTo = vi.fn();
    renderBoard("inc_0892", zoomTo, setupReady());
    const btn = screen.getByRole("button", { name: /Open Evidence Studio/ });
    fireEvent.keyDown(btn, { key: "Enter" });
    expect(zoomTo).toHaveBeenCalledWith(2, expect.anything());
  });

  it("calls zoomTo(2) on Space key", () => {
    const zoomTo = vi.fn();
    renderBoard("inc_0892", zoomTo, setupReady());
    const btn = screen.getByRole("button", { name: /Open Evidence Studio/ });
    fireEvent.keyDown(btn, { key: " " });
    expect(zoomTo).toHaveBeenCalledWith(2, expect.anything());
  });
});

describe("LensIncidentBoard — sparse diagnosis", () => {
  it("renders sparse state as a full board with partial evidence markers", () => {
    const qc = makeClient();
    qc.setQueryData(
      curatedQueries.extendedIncident("inc_0892").queryKey,
      extendedIncidentSparse,
    );

    renderBoard("inc_0892", vi.fn(), qc);

    expect(document.querySelector(".lens-board-state-note")).not.toBeNull();
    expect(document.querySelectorAll(".lens-board-chain-step")).toHaveLength(1);
    expect(document.querySelectorAll(".lens-board-check-item")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Open Evidence Studio/i })).toBeInTheDocument();
  });
});
