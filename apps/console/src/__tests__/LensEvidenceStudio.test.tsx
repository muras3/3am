import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  evidenceSparse,
} from "../__fixtures__/curated/evidence.js";
import {
  extendedIncidentReady,
  extendedIncidentPending,
  extendedIncidentSparse,
} from "../__fixtures__/curated/extended-incident.js";
import type { EvidenceQueryResponse } from "../api/curated-types.js";

let mockSearch: LensSearchParams = {
  level: 2,
  tab: "traces",
  incidentId: "inc_0892",
};
const mockNavigate = vi.fn();
const groundedAnswer: EvidenceQueryResponse = {
  question: "Why are checkout payments failing?",
  status: "answered",
  segments: [
    {
      id: "seg-1",
      kind: "fact",
      text: "Stripe API is returning 429 responses on the checkout path.",
      evidenceRefs: [{ kind: "span", id: "a3f8c91d:stripe-charge-001" }],
    },
    {
      id: "seg-2",
      kind: "inference",
      text: "That pattern is consistent with the existing diagnosis that Stripe quota pressure is driving the failure.",
      evidenceRefs: [
        { kind: "span", id: "a3f8c91d:stripe-charge-001" },
        { kind: "metric_group", id: "hyp-trigger" },
      ],
    },
    {
      id: "seg-3",
      kind: "unknown",
      text: "The current evidence does not prove whether Stripe changed the account quota.",
      evidenceRefs: [{ kind: "absence", id: "claim-no-retry" }],
    },
  ],
  evidenceSummary: { traces: 1, metrics: 1, logs: 1 },
  followups: [
    { question: "Do the metrics show the same failure window?", targetEvidenceKinds: ["metrics"] },
  ],
};

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
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

function getStatusBanner() {
  return document.querySelector(".lens-ev-empty-banner");
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

function setupSparse() {
  const qc = makeClient();
  qc.setQueryData(
    curatedQueries.extendedIncident("inc_0892").queryKey,
    extendedIncidentSparse,
  );
  qc.setQueryData(
    curatedQueries.evidence("inc_0892").queryKey,
    evidenceSparse,
  );
  return qc;
}

function renderQAFrame(
  qa: typeof evidenceReady.qa,
  overrides: Record<string, unknown> = {},
) {
  const props = {
    qa,
    inputValue: qa.question,
    isSubmitting: false,
    onInputChange: vi.fn(),
    onSubmitQuestion: vi.fn(),
    ...overrides,
  };
  return { ...render(<QAFrame {...(props as Parameters<typeof QAFrame>[0])} />), ...props };
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
  it("renders Q&A frame with question in input", () => {
    renderStudio("inc_0892", setupReady());
    // The question is rendered as the input's value
    expect(
      screen.getByDisplayValue("Why are checkout payments failing?"),
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
  it("shows a status banner when evidenceDensity is empty", () => {
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
    expect(getStatusBanner()).not.toBeNull();
    expect(document.querySelectorAll(".lens-ev-empty-panel")).toHaveLength(2);
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
    expect(screen.getByDisplayValue(evidencePending.qa.question)).toBeInTheDocument();
    expect(document.querySelector(".lens-ev-qa-answer-placeholder")).not.toBeNull();
    expect(document.querySelector(".lens-ev-qa-no-answer")).not.toBeNull();
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
  it("renders question in input field and answer text", () => {
    renderQAFrame(evidenceReady.qa);
    // The question is the input's value (not rendered as paragraph text)
    expect(
      screen.getByDisplayValue("Why are checkout payments failing?"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Stripe API is returning 429/)).toBeInTheDocument();
  });

  it("renders follow-up chips", () => {
    renderQAFrame(evidenceReady.qa);
    const chips = document.querySelectorAll(".lens-ev-qa-chip");
    expect(chips.length).toBeGreaterThan(0);
  });

  it("renders fixed fallback QA object from receiver contract", () => {
    renderQAFrame(evidencePending.qa);
    expect(screen.getByDisplayValue(evidencePending.qa.question)).toBeInTheDocument();
    expect(document.querySelector(".lens-ev-qa-answer-placeholder")).not.toBeNull();
    expect(screen.getByText(evidencePending.qa.noAnswerReason!)).toBeInTheDocument();
  });

  it("shows noAnswerReason when present", () => {
    const qa = { ...evidenceReady.qa, noAnswerReason: "Insufficient data to answer" };
    renderQAFrame(qa);
    expect(screen.getByText("Insufficient data to answer")).toBeInTheDocument();
  });
});

describe("QAFrame — interaction", () => {
  it("typing in input calls onInputChange", async () => {
    const user = userEvent.setup();
    const { onInputChange } = renderQAFrame(evidenceReady.qa, { inputValue: "" });
    const input = screen.getByRole("textbox", { name: /ask a grounded question/i });
    await user.clear(input);
    await user.type(input, "new question");
    expect(onInputChange).toHaveBeenCalled();
  });

  it("submitting form calls onSubmitQuestion with trimmed value", async () => {
    const user = userEvent.setup();
    const onSubmitQuestion = vi.fn();
    renderQAFrame(evidenceReady.qa, { inputValue: "  my question  ", onSubmitQuestion });
    const submitBtn = screen.getByRole("button", { name: /ask/i });
    await user.click(submitBtn);
    expect(onSubmitQuestion).toHaveBeenCalledWith("my question", false);
  });

  it("submit button disabled when input is empty", () => {
    renderQAFrame(evidenceReady.qa, { inputValue: "" });
    const submitBtn = screen.getByRole("button", { name: /ask/i });
    expect(submitBtn).toBeDisabled();
  });

  it("submit button disabled when isSubmitting=true", () => {
    renderQAFrame(evidenceReady.qa, { isSubmitting: true });
    const submitBtn = screen.getByRole("button", { name: /checking/i });
    expect(submitBtn).toBeDisabled();
  });

  it("submit button shows 'Checking…' when isSubmitting=true", () => {
    renderQAFrame(evidenceReady.qa, { isSubmitting: true });
    expect(screen.getByRole("button", { name: /checking/i })).toHaveTextContent("Checking…");
  });

  it("input disabled when isSubmitting=true", () => {
    renderQAFrame(evidenceReady.qa, { isSubmitting: true });
    const input = screen.getByRole("textbox", { name: /ask a grounded question/i });
    expect(input).toBeDisabled();
  });

  it("error message rendered when submitError provided (role=alert)", () => {
    renderQAFrame(evidenceReady.qa, { submitError: "Network error" });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Network error");
  });

  it("latest grounded response renders segment labels and text", () => {
    renderQAFrame(evidenceReady.qa, { latestResponse: groundedAnswer });
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Fact");
    expect(status).toHaveTextContent("Inference");
    expect(status).toHaveTextContent("Unknown");
    expect(status).toHaveAttribute("aria-live", "polite");
  });

  it("follow-up chip click calls onSubmitQuestion with chip question", async () => {
    const user = userEvent.setup();
    const onSubmitQuestion = vi.fn();
    renderQAFrame(evidenceReady.qa, { onSubmitQuestion });
    const chip = screen.getByText("Is there retry logic?");
    await user.click(chip);
    expect(onSubmitQuestion).toHaveBeenCalledWith("Is there retry logic?", true);
  });

  it("follow-up chips disabled when isSubmitting=true", () => {
    renderQAFrame(evidenceReady.qa, { isSubmitting: true });
    const chips = document.querySelectorAll(".lens-ev-qa-chip");
    chips.forEach((chip) => {
      expect(chip).toBeDisabled();
    });
  });

  it("evidence ref click calls navigate with correct tab/targetId (span → traces)", async () => {
    const user = userEvent.setup();
    renderQAFrame(evidenceReady.qa);
    const refBtn = screen.getAllByRole("button", {
      name: /view evidence: span a3f8c91d:stripe-charge-001/i,
    })[0]!;
    await user.click(refBtn);
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({
          tab: "traces",
          targetId: "stripe-charge-001",
        }),
      }),
    );
  });

  it("evidence ref click for metric_group → metrics tab", async () => {
    const user = userEvent.setup();
    renderQAFrame(evidenceReady.qa);
    const refBtn = screen.getAllByRole("button", {
      name: /view evidence: metric_group hyp-trigger/i,
    })[0]!;
    await user.click(refBtn);
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({
          tab: "metrics",
          targetId: "hyp-trigger",
        }),
      }),
    );
  });

  it("no-answer state uses placeholder treatment", () => {
    renderQAFrame(evidencePending.qa);
    expect(document.querySelector(".lens-ev-qa-answer-placeholder")).not.toBeNull();
    expect(document.querySelector(".lens-ev-qa-no-answer")).not.toBeNull();
    expect(
      screen.getByText(evidencePending.qa.noAnswerReason!),
    ).toBeInTheDocument();
  });

  it("evidence ref keyboard Enter calls navigate", async () => {
    const user = userEvent.setup();
    renderQAFrame(evidenceReady.qa);
    const refBtn = screen.getAllByRole("button", {
      name: /view evidence: span a3f8c91d:stripe-charge-001/i,
    })[0]!;
    refBtn.focus();
    await user.keyboard("{Enter}");
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({
          tab: "traces",
          targetId: "stripe-charge-001",
        }),
      }),
    );
  });

  it("evidence ref keyboard Space calls navigate", async () => {
    const user = userEvent.setup();
    renderQAFrame(evidenceReady.qa);
    const refBtn = screen.getAllByRole("button", {
      name: /view evidence: span a3f8c91d:stripe-charge-001/i,
    })[0]!;
    refBtn.focus();
    await user.keyboard(" ");
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({
          tab: "traces",
          targetId: "stripe-charge-001",
        }),
      }),
    );
  });

  it("evidence summary text renders correctly", () => {
    renderQAFrame(evidenceReady.qa);
    expect(screen.getAllByText(/12 traces, 3 metrics, 28 logs/).length).toBeGreaterThan(0);
  });

  it("evidence ref kind=log_cluster navigates to logs tab", async () => {
    const user = userEvent.setup();
    renderQAFrame(evidenceReady.qa, {
      latestResponse: {
        question: evidenceReady.qa.question,
        status: "answered",
        segments: [{
          id: "log-cluster-seg",
          kind: "fact",
          text: "A log cluster captures the Stripe 429 burst.",
          evidenceRefs: [{ kind: "log_cluster", id: "claim-429" }],
        }],
        evidenceSummary: evidenceReady.qa.evidenceSummary,
        followups: evidenceReady.qa.followups,
      },
    });
    const refBtn = screen.getByRole("button", {
      name: /view evidence: log_cluster claim-429/i,
    });
    await user.click(refBtn);
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({
          tab: "logs",
          targetId: "claim-429",
        }),
      }),
    );
  });

  it("span targetId is extracted from traceId:spanId format", async () => {
    const user = userEvent.setup();
    renderQAFrame(evidenceReady.qa);
    const refBtn = screen.getAllByRole("button", {
      name: /view evidence: span a3f8c91d:stripe-charge-001/i,
    })[0]!;
    await user.click(refBtn);
    const call = mockNavigate.mock.calls[0]?.[0];
    expect(call.search.targetId).toBe("stripe-charge-001");
    // Not the full "a3f8c91d:stripe-charge-001"
    expect(call.search.targetId).not.toContain(":");
  });
});

describe("LensProofCards — cross-surface navigation", () => {
  it("clicking trigger card navigates to traces tab with span targetId 'stripe-charge-001'", () => {
    render(<LensProofCards cards={evidenceReady.proofCards} />);
    const triggerCard = screen.getByText("External Trigger").closest("[role='button']");
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

  it("clicking design_gap navigates to metrics tab with targetId 'stripe_client_error_rate'", () => {
    render(<LensProofCards cards={evidenceReady.proofCards} />);
    const designCard = screen.getByText("Design Gap").closest("[role='button']");
    fireEvent.click(designCard!);
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({
          proof: "design_gap",
          tab: "metrics",
          targetId: "stripe_client_error_rate",
        }),
        replace: true,
      }),
    );
  });

  it("keyboard Enter on trigger card triggers same navigation", () => {
    render(<LensProofCards cards={evidenceReady.proofCards} />);
    const triggerCard = screen.getByText("External Trigger").closest("[role='button']");
    fireEvent.keyDown(triggerCard!, { key: "Enter" });
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

  it("clicking recovery card navigates to traces tab with span targetId", () => {
    render(<LensProofCards cards={evidenceReady.proofCards} />);
    const recoveryCard = screen.getByText("Recovery Signal").closest("[role='button']");
    fireEvent.click(recoveryCard!);
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({
          proof: "recovery",
          tab: "traces",
          targetId: "stripe-retry-001",
        }),
        replace: true,
      }),
    );
  });

  it("keyboard Space on card triggers navigation", () => {
    render(<LensProofCards cards={evidenceReady.proofCards} />);
    const triggerCard = screen.getByText("External Trigger").closest("[role='button']");
    fireEvent.keyDown(triggerCard!, { key: " " });
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({
          proof: "trigger",
          tab: "traces",
        }),
        replace: true,
      }),
    );
  });

  it("active card has aria-pressed=true", () => {
    mockSearch = { ...mockSearch, proof: "trigger" };
    render(<LensProofCards cards={evidenceReady.proofCards} />);
    const triggerCard = screen.getByText("External Trigger").closest("[role='button']");
    expect(triggerCard).toHaveAttribute("aria-pressed", "true");
    const designCard = screen.getByText("Design Gap").closest("[role='button']");
    expect(designCard).toHaveAttribute("aria-pressed", "false");
  });

  it("pending card with empty evidenceRefs navigates without targetId", () => {
    render(<LensProofCards cards={evidencePending.proofCards} />);
    const pendingCard = document.querySelector('[data-proof-id="design_gap"]');
    fireEvent.click(pendingCard!);
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({
          proof: "design_gap",
          targetId: undefined,
        }),
        replace: true,
      }),
    );
  });

  it("evidence query refs for absence navigate to logs", async () => {
    const user = userEvent.setup();
    renderQAFrame(evidenceReady.qa, { latestResponse: groundedAnswer });
    const refBtn = screen.getByRole("button", {
      name: /view evidence: absence claim-no-retry/i,
    });
    await user.click(refBtn);
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({
          tab: "logs",
          targetId: "claim-no-retry",
        }),
      }),
    );
  });
});

describe("LensEvidenceStudio — degraded states", () => {
  it("sparse fixture renders proof cards (3 cards, mix of confirmed/pending)", () => {
    renderStudio("inc_0892", setupSparse());
    const cards = document.querySelectorAll(".lens-ev-proof-card");
    expect(cards).toHaveLength(3);
    expect(document.querySelectorAll(".lens-ev-pc-status-confirmed").length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".lens-ev-pc-status-pending").length).toBeGreaterThan(0);
  });

  it("sparse fixture data attributes: data-evidence-density='sparse', data-diagnosis-state='ready'", () => {
    renderStudio("inc_0892", setupSparse());
    const studio = document.querySelector("[data-evidence-density='sparse']");
    expect(studio).not.toBeNull();
    expect(studio).toHaveAttribute("data-diagnosis-state", "ready");
  });

  it("pending fixture mounts the degraded-status banner", () => {
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
    expect(getStatusBanner()).not.toBeNull();
    expect(document.querySelectorAll(".lens-ev-empty-list li")).toHaveLength(6);
  });

  it("pending fixture data attributes: data-evidence-density='empty', data-diagnosis-state='pending'", () => {
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
    const studio = document.querySelector("[data-evidence-density='empty']");
    expect(studio).not.toBeNull();
    expect(studio).toHaveAttribute("data-diagnosis-state", "pending");
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

// ── Integration: Q&A mutation ──────────────────────────────────

describe("LensEvidenceStudio — Q&A mutation integration", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(groundedAnswer),
    });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Q&A submit calls evidence query mutation via form submit", async () => {
    const user = userEvent.setup();
    renderStudio("inc_0892", setupReady());
    const input = screen.getByLabelText("Ask a grounded question about this incident");
    await user.clear(input);
    await user.type(input, "Test question");
    const submitBtn = screen.getByRole("button", { name: "Ask" });
    await user.click(submitBtn);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/incidents/inc_0892/evidence/query"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("Q&A follow-up chip triggers evidence query mutation", async () => {
    const user = userEvent.setup();
    renderStudio("inc_0892", setupReady());
    const chip = screen.getByText("Is there retry logic?");
    await user.click(chip);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/incidents/inc_0892/evidence/query"),
      expect.objectContaining({ method: "POST" }),
    );
  });
});
