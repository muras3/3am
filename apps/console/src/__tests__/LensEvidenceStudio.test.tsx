import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { LensSearchParams } from "../routes/__root.js";
import { LensEvidenceStudio } from "../components/lens/evidence/LensEvidenceStudio.js";
import { ContextBar } from "../components/lens/evidence/ContextBar.js";
import { LensProofCards } from "../components/lens/evidence/LensProofCards.js";
import { QAFrame } from "../components/lens/evidence/QAFrame.js";
import { LensEvidenceTabs } from "../components/lens/evidence/LensEvidenceTabs.js";
import { LensSideRail } from "../components/lens/evidence/LensSideRail.js";
import { curatedQueries } from "../api/queries.js";
import {
  evidenceReady,
  evidencePending,
} from "../__fixtures__/curated/evidence.js";
import {
  extendedIncidentReady,
  extendedIncidentPending,
} from "../__fixtures__/curated/extended-incident.js";

let mockSearch: LensSearchParams = {
  level: 2,
  tab: "traces",
  incidentId: "inc_0892",
};
const mockNavigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useSearch: () => mockSearch,
  useNavigate: () => mockNavigate,
}));

// ── Helpers ───────────────────────────────────────────────────

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderStudio(
  incidentId: string,
  queryClient: QueryClient,
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <LensEvidenceStudio incidentId={incidentId} zoomTo={vi.fn()} />
    </QueryClientProvider>,
  );
}

function setupReady() {
  const qc = makeClient();
  qc.setQueryData(
    curatedQueries.extendedIncident("inc_0892").queryKey,
    extendedIncidentReady,
  );
  qc.setQueryData(
    curatedQueries.evidence("inc_0892").queryKey,
    evidenceReady,
  );
  return qc;
}

// ── Tests ─────────────────────────────────────────────────────

beforeEach(() => {
  mockSearch = {
    level: 2,
    tab: "traces" as const,
    incidentId: "inc_0892",
  };
  mockNavigate.mockClear();
});

describe("LensEvidenceStudio — context bar", () => {
  it("renders context bar with incident ID", () => {
    renderStudio("inc_0892", setupReady());
    expect(screen.getByText("inc_0892")).toBeInTheDocument();
  });

  it("renders context bar with incident headline", () => {
    renderStudio("inc_0892", setupReady());
    expect(
      screen.getByText(/Stripe API rate limit cascade/),
    ).toBeInTheDocument();
  });

  it("renders context bar with action text", () => {
    renderStudio("inc_0892", setupReady());
    expect(
      screen.getByText(/Enable request batching on StripeClient/),
    ).toBeInTheDocument();
  });
});

describe("LensEvidenceStudio — proof cards", () => {
  it("renders 3 proof cards from fixture data", () => {
    renderStudio("inc_0892", setupReady());
    const cards = document.querySelectorAll(".lens-ev-proof-card");
    expect(cards).toHaveLength(3);
  });

  it("renders proof card labels", () => {
    renderStudio("inc_0892", setupReady());
    expect(screen.getByText("External Trigger")).toBeInTheDocument();
    expect(screen.getByText("Design Gap")).toBeInTheDocument();
    expect(screen.getByText("Recovery Signal")).toBeInTheDocument();
  });

  it("renders status badges on proof cards", () => {
    renderStudio("inc_0892", setupReady());
    const confirmed = document.querySelectorAll(".lens-ev-pc-status-confirmed");
    expect(confirmed.length).toBeGreaterThan(0);
    const inferred = document.querySelectorAll(".lens-ev-pc-status-inferred");
    expect(inferred.length).toBeGreaterThan(0);
  });
});

describe("LensEvidenceStudio — Q&A frame", () => {
  it("renders Q&A frame with question", () => {
    renderStudio("inc_0892", setupReady());
    expect(
      screen.getByText("Why are checkout payments failing?"),
    ).toBeInTheDocument();
  });

  it("renders Q&A answer text", () => {
    renderStudio("inc_0892", setupReady());
    expect(
      screen.getByText(/Stripe API is returning 429/),
    ).toBeInTheDocument();
  });

  it("renders follow-up chips", () => {
    renderStudio("inc_0892", setupReady());
    expect(screen.getByText("Is there retry logic?")).toBeInTheDocument();
    expect(screen.getByText("When exactly did this start?")).toBeInTheDocument();
    expect(screen.getByText("What's the full blast radius?")).toBeInTheDocument();
  });
});

describe("LensEvidenceStudio — tab bar", () => {
  it("renders 3 tabs with correct labels", () => {
    renderStudio("inc_0892", setupReady());
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(screen.getByRole("tab", { name: /Traces/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Metrics/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Logs/ })).toBeInTheDocument();
  });

  it("tabs have correct ARIA attributes", () => {
    renderStudio("inc_0892", setupReady());
    const tablist = screen.getByRole("tablist");
    expect(tablist).toBeInTheDocument();

    const tabs = screen.getAllByRole("tab");
    tabs.forEach((tab) => {
      expect(tab).toHaveAttribute("aria-selected");
      expect(tab).toHaveAttribute("aria-controls");
      expect(tab).toHaveAttribute("id");
    });
  });

  it("active tab matches URL param (traces by default)", () => {
    renderStudio("inc_0892", setupReady());
    const tracesTab = screen.getByRole("tab", { name: /Traces/ });
    expect(tracesTab).toHaveAttribute("aria-selected", "true");
    const metricsTab = screen.getByRole("tab", { name: /Metrics/ });
    expect(metricsTab).toHaveAttribute("aria-selected", "false");
  });

  it("active tab reflects URL param when metrics", () => {
    mockSearch = { ...mockSearch, tab: "metrics" };
    renderStudio("inc_0892", setupReady());
    const metricsTab = screen.getByRole("tab", { name: /Metrics/ });
    expect(metricsTab).toHaveAttribute("aria-selected", "true");
  });
});

describe("LensEvidenceStudio — proof card click updates navigation", () => {
  it("clicking proof card calls navigate with proof and tab params", async () => {
    renderStudio("inc_0892", setupReady());

    const triggerCard = screen.getByText("External Trigger").closest("[role='button']");
    expect(triggerCard).not.toBeNull();

    fireEvent.click(triggerCard!);

    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({
          proof: "trigger",
          tab: "traces",
          targetId: "stripe-charge-001",
        }),
        replace: true,
      }),
    );
  });

  it("clicking design gap card navigates to metrics tab", () => {
    renderStudio("inc_0892", setupReady());

    const designCard = screen.getByText("Design Gap").closest("[role='button']");
    fireEvent.click(designCard!);

    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({
          proof: "design_gap",
          tab: "metrics",
          targetId: "stripe_client_error_rate",
        }),
      }),
    );
  });
});

describe("LensEvidenceStudio — side notes", () => {
  it("renders side notes from fixture data", () => {
    renderStudio("inc_0892", setupReady());
    expect(screen.getByText("Confidence")).toBeInTheDocument();
    expect(screen.getByText("Uncertainty")).toBeInTheDocument();
    expect(screen.getByText("Affected Dependencies")).toBeInTheDocument();
  });

  it("primary side note has correct class", () => {
    renderStudio("inc_0892", setupReady());
    const primaryNotes = document.querySelectorAll(".lens-ev-side-note-primary");
    expect(primaryNotes.length).toBeGreaterThan(0);
  });
});

describe("LensEvidenceStudio — empty state", () => {
  it("shows empty state when evidenceDensity is empty", () => {
    const qc = makeClient();
    qc.setQueryData(
      curatedQueries.extendedIncident("inc_0892").queryKey,
      extendedIncidentPending,
    );
    qc.setQueryData(
      curatedQueries.evidence("inc_0892").queryKey,
      evidencePending,
    );
    renderStudio("inc_0892", qc);
    expect(screen.getAllByText(/Evidence is being collected/).length).toBeGreaterThan(0);
  });

  it("keeps proof card boxes in empty state", () => {
    const qc = makeClient();
    qc.setQueryData(
      curatedQueries.extendedIncident("inc_0892").queryKey,
      extendedIncidentPending,
    );
    qc.setQueryData(
      curatedQueries.evidence("inc_0892").queryKey,
      evidencePending,
    );
    renderStudio("inc_0892", qc);
    const cards = document.querySelectorAll(".lens-ev-proof-card");
    expect(cards).toHaveLength(3);
  });

  it("renders fixed-shape pending QA contract in empty state", () => {
    const qc = makeClient();
    qc.setQueryData(
      curatedQueries.extendedIncident("inc_0892").queryKey,
      extendedIncidentPending,
    );
    qc.setQueryData(
      curatedQueries.evidence("inc_0892").queryKey,
      evidencePending,
    );
    renderStudio("inc_0892", qc);
    expect(screen.getByText(evidencePending.qa.question)).toBeInTheDocument();
    expect(screen.getByText(evidencePending.qa.noAnswerReason!)).toBeInTheDocument();
  });
});

// ── Unit tests for sub-components ─────────────────────────────

describe("ContextBar", () => {
  it("renders incident ID and headline", () => {
    render(<ContextBar incident={extendedIncidentReady} />);
    expect(screen.getByText("inc_0892")).toBeInTheDocument();
    expect(screen.getByText(/Stripe API rate limit cascade/)).toBeInTheDocument();
  });
});

describe("LensProofCards", () => {
  it("renders proof cards from fixture data", () => {
    render(<LensProofCards cards={evidenceReady.proofCards} />);
    const cards = document.querySelectorAll(".lens-ev-proof-card");
    expect(cards).toHaveLength(3);
  });

  it("marks active card with active class when proof URL param matches", () => {
    mockSearch = { ...mockSearch, proof: "trigger" };
    render(<LensProofCards cards={evidenceReady.proofCards} />);
    const activeCards = document.querySelectorAll(".lens-ev-proof-card-active");
    expect(activeCards).toHaveLength(1);
  });

  it("calls navigate when card is clicked", () => {
    render(<LensProofCards cards={evidenceReady.proofCards} />);
    const firstCard = document.querySelector(".lens-ev-proof-card");
    fireEvent.click(firstCard!);
    expect(mockNavigate).toHaveBeenCalled();
  });

  it("clicking card keyboard activates navigation on Enter", () => {
    render(<LensProofCards cards={evidenceReady.proofCards} />);
    const firstCard = document.querySelector(".lens-ev-proof-card");
    fireEvent.keyDown(firstCard!, { key: "Enter" });
    expect(mockNavigate).toHaveBeenCalled();
  });

  it("renders pending cards from fixed receiver shape", () => {
    render(<LensProofCards cards={evidencePending.proofCards} />);
    expect(document.querySelectorAll(".lens-ev-proof-card")).toHaveLength(3);
    expect(screen.getAllByText("Pending").length).toBeGreaterThan(0);
  });
});

describe("QAFrame", () => {
  it("renders question and answer text", () => {
    render(<QAFrame qa={evidenceReady.qa} />);
    expect(
      screen.getByText("Why are checkout payments failing?"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Stripe API is returning 429/)).toBeInTheDocument();
  });

  it("renders follow-up chips", () => {
    render(<QAFrame qa={evidenceReady.qa} />);
    const chips = document.querySelectorAll(".lens-ev-qa-chip");
    expect(chips.length).toBeGreaterThan(0);
  });

  it("renders fixed fallback QA object from receiver contract", () => {
    render(<QAFrame qa={evidencePending.qa} />);
    expect(screen.getByText(evidencePending.qa.question)).toBeInTheDocument();
    expect(screen.getByText(evidencePending.qa.noAnswerReason!)).toBeInTheDocument();
  });

  it("shows noAnswerReason when present", () => {
    const qa = { ...evidenceReady.qa, noAnswerReason: "Insufficient data to answer" };
    render(<QAFrame qa={qa} />);
    expect(screen.getByText("Insufficient data to answer")).toBeInTheDocument();
  });
});

describe("LensEvidenceTabs", () => {
  it("renders 3 tabs", () => {
    render(<LensEvidenceTabs surfaces={evidenceReady.surfaces} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
  });

  it("tab list has correct role", () => {
    render(<LensEvidenceTabs surfaces={evidenceReady.surfaces} />);
    expect(screen.getByRole("tablist")).toBeInTheDocument();
  });

  it("active tab has aria-selected=true, others false", () => {
    render(<LensEvidenceTabs surfaces={evidenceReady.surfaces} />);
    const tracesTab = screen.getByRole("tab", { name: /Traces/ });
    expect(tracesTab).toHaveAttribute("aria-selected", "true");
    const metricsTab = screen.getByRole("tab", { name: /Metrics/ });
    expect(metricsTab).toHaveAttribute("aria-selected", "false");
    const logsTab = screen.getByRole("tab", { name: /Logs/ });
    expect(logsTab).toHaveAttribute("aria-selected", "false");
  });

  it("inactive tabs have tabIndex=-1, active tab has tabIndex=0", () => {
    render(<LensEvidenceTabs surfaces={evidenceReady.surfaces} />);
    const tracesTab = screen.getByRole("tab", { name: /Traces/ });
    expect(tracesTab).toHaveAttribute("tabindex", "0");
    const metricsTab = screen.getByRole("tab", { name: /Metrics/ });
    expect(metricsTab).toHaveAttribute("tabindex", "-1");
  });

  it("clicking a tab calls navigate with correct tab", () => {
    render(<LensEvidenceTabs surfaces={evidenceReady.surfaces} />);
    const metricsTab = screen.getByRole("tab", { name: /Metrics/ });
    fireEvent.click(metricsTab);
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({ tab: "metrics" }),
        replace: true,
      }),
    );
  });

  it("ArrowRight key moves focus to next tab", () => {
    render(<LensEvidenceTabs surfaces={evidenceReady.surfaces} />);
    const tracesTab = screen.getByRole("tab", { name: /Traces/ });
    fireEvent.keyDown(tracesTab, { key: "ArrowRight" });
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({ tab: "metrics" }),
      }),
    );
  });

  it("ArrowLeft key moves focus to previous tab (wraps around)", () => {
    render(<LensEvidenceTabs surfaces={evidenceReady.surfaces} />);
    const tracesTab = screen.getByRole("tab", { name: /Traces/ });
    fireEvent.keyDown(tracesTab, { key: "ArrowLeft" });
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({ tab: "logs" }),
      }),
    );
  });
});

describe("LensSideRail", () => {
  it("renders side notes from fixture data", () => {
    render(<LensSideRail notes={evidenceReady.sideNotes} />);
    expect(screen.getByText("Confidence")).toBeInTheDocument();
    expect(screen.getByText("Uncertainty")).toBeInTheDocument();
    expect(screen.getByText("Affected Dependencies")).toBeInTheDocument();
  });

  it("renders primary variant with .lens-ev-side-note-primary class", () => {
    render(<LensSideRail notes={evidenceReady.sideNotes} />);
    const primary = document.querySelectorAll(".lens-ev-side-note-primary");
    expect(primary).toHaveLength(1);
  });

  it("renders note content text", () => {
    render(<LensSideRail notes={evidenceReady.sideNotes} />);
    expect(screen.getByText(/High confidence.*Stripe 429 responses/)).toBeInTheDocument();
  });

  it("renders placeholder notes when notes array is empty", () => {
    const { container } = render(<LensSideRail notes={[]} />);
    expect(container.firstChild).not.toBeNull();
    expect(screen.getByText("Confidence")).toBeInTheDocument();
  });
});
