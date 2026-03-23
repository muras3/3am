import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { LensTracesView } from "../components/lens/evidence/LensTracesView.js";
import { LensMetricsView } from "../components/lens/evidence/LensMetricsView.js";
import { LensLogsView } from "../components/lens/evidence/LensLogsView.js";
import { QAFrame } from "../components/lens/evidence/QAFrame.js";
import { evidenceReady, evidenceSparse } from "../__fixtures__/curated/evidence.js";

const mockNavigate = vi.fn();

let mockSearchState = {
  level: 2,
  tab: "traces",
  incidentId: "inc_0892",
} as Record<string, unknown>;

vi.mock("@tanstack/react-router", () => ({
  useSearch: () => mockSearchState,
  useNavigate: () => mockNavigate,
}));

const { traces, metrics, logs } = evidenceReady.surfaces;

beforeEach(() => {
  mockSearchState = {
    level: 2,
    tab: "traces",
    incidentId: "inc_0892",
  };
  mockNavigate.mockClear();
});

// ── TracesView ─────────────────────────────────────────────────

describe("LensTracesView", () => {
  it("renders observed trace groups", () => {
    render(<LensTracesView surface={traces} />);
    // Each observed trace group should be in the DOM
    for (const group of traces.observed) {
      // Route is shown in trace header
      expect(screen.getAllByText(group.route).length).toBeGreaterThan(0);
    }
  });

  it("renders span names from observed traces", () => {
    render(<LensTracesView surface={traces} />);
    // First observed group has 3 spans
    const firstGroup = traces.observed[0]!;
    for (const span of firstGroup.spans) {
      expect(screen.getAllByText(span.name).length).toBeGreaterThan(0);
    }
  });

  it("highlights smoking gun span", () => {
    render(<LensTracesView surface={traces} />);
    const gunRow = document.querySelector(".smoking-gun");
    expect(gunRow).not.toBeNull();
    // The smoking gun span should contain the matching span name
    const smokingSpan = traces.observed[0]!.spans.find(
      (s) => s.spanId === traces.smokingGunSpanId,
    );
    expect(smokingSpan).toBeDefined();
    expect(gunRow?.textContent).toContain(smokingSpan!.name);
  });

  it("does NOT apply smoking-gun class to non-matching spans", () => {
    render(<LensTracesView surface={traces} />);
    const gunRows = document.querySelectorAll(".smoking-gun");
    // Only one span should be highlighted
    expect(gunRows.length).toBe(1);
  });

  it("baseline group is muted by default (hidden)", () => {
    render(<LensTracesView surface={traces} />);
    const baselineGroup = document.querySelector(".lens-traces-baseline-group");
    expect(baselineGroup).not.toBeNull();
    expect(baselineGroup).toHaveClass("muted");
  });

  it("toggles baseline visibility on button click", async () => {
    const user = userEvent.setup();
    render(<LensTracesView surface={traces} />);
    const toggle = screen.getByRole("button", { name: /show expected trace/i });
    expect(toggle).toBeInTheDocument();

    await user.click(toggle);
    const baselineGroup = document.querySelector(".lens-traces-baseline-group");
    expect(baselineGroup).not.toHaveClass("muted");

    await user.click(toggle);
    expect(baselineGroup).toHaveClass("muted");
  });

  it("baseline toggle responds to Enter key", async () => {
    const user = userEvent.setup();
    render(<LensTracesView surface={traces} />);
    const toggle = screen.getByRole("button", { name: /show expected trace/i });

    toggle.focus();
    await user.keyboard("{Enter}");
    expect(document.querySelector(".lens-traces-baseline-group")).not.toHaveClass("muted");
  });

  it("only the smoking gun span auto-expands on initial render", () => {
    render(<LensTracesView surface={traces} />);
    // The smoking gun span (stripe-api-001) auto-expands; others stay closed
    const openDetails = document.querySelectorAll(".lens-traces-span-detail.open");
    // Exactly 1 open (the smoking gun)
    expect(openDetails.length).toBe(1);
    // Non-smoking-gun expandable spans should remain closed
    const allDetails = document.querySelectorAll(".lens-traces-span-detail");
    const closedDetails = Array.from(allDetails).filter(
      (el) => !el.classList.contains("open"),
    );
    expect(closedDetails.length).toBe(allDetails.length - 1);
  });

  it("span detail expands on click for spans with attributes", async () => {
    const user = userEvent.setup();
    render(<LensTracesView surface={traces} />);
    // Find an expandable row (has attributes)
    const expandableRows = document.querySelectorAll(".lens-traces-span-row.expandable");
    expect(expandableRows.length).toBeGreaterThan(0);

    await user.click(expandableRows[0] as HTMLElement);
    const openDetail = document.querySelector(".lens-traces-span-detail.open");
    expect(openDetail).not.toBeNull();
  });

  it("span detail expands on Enter key", async () => {
    const user = userEvent.setup();
    render(<LensTracesView surface={traces} />);
    const expandableRow = document.querySelector(
      ".lens-traces-span-row.expandable",
    ) as HTMLElement;
    expandableRow.focus();
    await user.keyboard("{Enter}");
    expect(document.querySelector(".lens-traces-span-detail.open")).not.toBeNull();
  });

  it("span detail expands on Space key", async () => {
    const user = userEvent.setup();
    render(<LensTracesView surface={traces} />);
    const expandableRow = document.querySelector(
      ".lens-traces-span-row.expandable",
    ) as HTMLElement;
    expandableRow.focus();
    await user.keyboard(" ");
    expect(document.querySelector(".lens-traces-span-detail.open")).not.toBeNull();
  });

  it("trace groups carry data-proof attribute", () => {
    render(<LensTracesView surface={traces} />);
    const proofEls = document.querySelectorAll("[data-proof]");
    expect(proofEls.length).toBeGreaterThan(0);
  });

  it("span rows carry data-target-id matching spanId", () => {
    render(<LensTracesView surface={traces} />);
    const firstSpan = traces.observed[0]!.spans[0]!;
    const el = document.querySelector(`[data-target-id="${firstSpan.spanId}"]`);
    expect(el).not.toBeNull();
  });

  it("renders empty state when no observed traces", () => {
    render(
      <LensTracesView
        surface={{ observed: [], expected: [], smokingGunSpanId: null }}
      />,
    );
    expect(screen.getByText(/only limited traces are available/i)).toBeInTheDocument();
  });

  it("renders disabled baseline toggle when no expected traces", () => {
    render(
      <LensTracesView
        surface={{ observed: traces.observed, expected: [], smokingGunSpanId: null }}
      />,
    );
    expect(screen.getByRole("button", { name: /expected trace is sparse/i })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("smoking gun span auto-expands on initial render (no selectedTargetId in URL)", () => {
    // mockSearchState has no targetId — smoking gun should auto-expand
    render(<LensTracesView surface={traces} />);
    // The smoking gun span (stripe-api-001) has attributes, so it should be open
    const openDetail = document.querySelector(".lens-traces-span-detail.open");
    expect(openDetail).not.toBeNull();
  });

  it("smoking gun expanded shows attributes dl", () => {
    render(<LensTracesView surface={traces} />);
    // After auto-expand the attribute list should be visible
    const attrList = document.querySelector(".lens-traces-attr-list");
    expect(attrList).not.toBeNull();
  });

  it("smoking gun span does NOT auto-expand when selectedTargetId points elsewhere", () => {
    // Point targetId at a different span — smoking gun should NOT expand
    mockSearchState = { ...mockSearchState, targetId: "checkout-001" };
    render(<LensTracesView surface={traces} />);
    // The smoking-gun row should NOT be open (checkout-001 is expandable and matches)
    const smokingGunRow = document.querySelector(".smoking-gun");
    expect(smokingGunRow).not.toBeNull();
    // aria-expanded on the smoking-gun span row should be false
    expect(smokingGunRow).toHaveAttribute("aria-expanded", "false");
  });
});

// ── TracesView span detail content ─────────────────────────────

describe("LensTracesView — span detail content", () => {
  it("expanded span shows attribute key-value pairs", async () => {
    const user = userEvent.setup();
    render(<LensTracesView surface={traces} />);
    // Click first expandable span
    const expandableRow = document.querySelector(
      ".lens-traces-span-row.expandable",
    ) as HTMLElement;
    await user.click(expandableRow);

    // After expanding, attribute key should appear in a dt
    const attrKeys = document.querySelectorAll(".lens-traces-attr-key");
    expect(attrKeys.length).toBeGreaterThan(0);
    const attrVals = document.querySelectorAll(".lens-traces-attr-val");
    expect(attrVals.length).toBeGreaterThan(0);
  });

  it("expanded span shows correlated log rows with timestamp/severity/body", async () => {
    const user = userEvent.setup();
    render(<LensTracesView surface={traces} />);
    // The checkout-001 span has correlatedLogs — click it
    const checkoutRow = document.querySelector(
      `[data-target-id="checkout-001"]`,
    ) as HTMLElement;
    expect(checkoutRow).not.toBeNull();
    await user.click(checkoutRow);

    const corrLogs = document.querySelectorAll(".lens-traces-corr-log-row");
    expect(corrLogs.length).toBeGreaterThan(0);
    // Each correlated log row should have timestamp, severity and body spans
    const logTs = document.querySelectorAll(".lens-traces-corr-log-ts");
    expect(logTs.length).toBeGreaterThan(0);
    const logSev = document.querySelectorAll(".lens-traces-corr-log-sev");
    expect(logSev.length).toBeGreaterThan(0);
    const logBody = document.querySelectorAll(".lens-traces-corr-log-body");
    expect(logBody.length).toBeGreaterThan(0);
  });

  it("span without attributes or correlatedLogs is NOT expandable (no role=button)", () => {
    // baseline spans have no extra attrs
    const spanWithoutDetail = traces.expected[0]?.spans.find(
      (s) => !s.attributes || Object.keys(s.attributes ?? {}).length === 0,
    );
    // In the fixture, baseline-stripe-001 has {"http.status_code": 200} but
    // baseline spans are in the expected group. We test a minimal surface
    // where all spans have no attributes and no correlatedLogs.
    const minimalSurface = {
      observed: [
        {
          traceId: "t1",
          route: "GET /health",
          status: 200,
          durationMs: 10,
          spans: [
            {
              spanId: "s1",
              name: "GET /health",
              durationMs: 10,
              status: "ok" as const,
            },
          ],
        },
      ],
      expected: [],
      smokingGunSpanId: null,
    };
    render(<LensTracesView surface={minimalSurface} />);
    const spanRow = document.querySelector(`[data-target-id="s1"]`);
    expect(spanRow).not.toBeNull();
    // Should not have role=button since it's not expandable
    expect(spanRow).not.toHaveAttribute("role", "button");
  });
});

// ── MetricsView ────────────────────────────────────────────────

describe("LensMetricsView", () => {
  it("renders hypothesis groups", () => {
    render(<LensMetricsView surface={metrics} />);
    const groups = document.querySelectorAll(".lens-metrics-hyp-group");
    expect(groups.length).toBe(metrics.hypotheses.length);
  });

  it("colors headers by type — trigger gets accent-soft background class", () => {
    render(<LensMetricsView surface={metrics} />);
    const triggerHeader = document.querySelector(".lens-metrics-hyp-header-trigger");
    expect(triggerHeader).not.toBeNull();
  });

  it("colors headers by type — cascade gets amber class", () => {
    render(<LensMetricsView surface={metrics} />);
    const cascadeHeader = document.querySelector(".lens-metrics-hyp-header-cascade");
    expect(cascadeHeader).not.toBeNull();
  });

  it("colors headers by type — recovery gets good class", () => {
    render(<LensMetricsView surface={metrics} />);
    const recoveryHeader = document.querySelector(".lens-metrics-hyp-header-recovery");
    expect(recoveryHeader).not.toBeNull();
  });

  it("renders metric rows for each hypothesis", () => {
    render(<LensMetricsView surface={metrics} />);
    const rows = document.querySelectorAll(".lens-metrics-metric-row");
    const totalMetrics = metrics.hypotheses.reduce((sum, h) => sum + h.metrics.length, 0);
    expect(rows.length).toBe(totalMetrics);
  });

  it("shows metric names", () => {
    render(<LensMetricsView surface={metrics} />);
    const firstName = metrics.hypotheses[0]!.metrics[0]!.name;
    expect(screen.getAllByText(firstName).length).toBeGreaterThan(0);
  });

  it("shows expected values in metric rows", () => {
    render(<LensMetricsView surface={metrics} />);
    const firstExpected = metrics.hypotheses[0]!.metrics[0]!.expected;
    // Expected text rendered as "expected: X"
    const els = document.querySelectorAll(".lens-metrics-metric-expected");
    expect(els.length).toBeGreaterThan(0);
    const found = Array.from(els).some((el) => el.textContent?.includes(firstExpected));
    expect(found).toBe(true);
  });

  it("shows verdict badges (Confirmed / Inferred)", () => {
    render(<LensMetricsView surface={metrics} />);
    expect(screen.getAllByText("Confirmed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Inferred").length).toBeGreaterThan(0);
  });

  it("Confirmed verdict gets confirmed class", () => {
    render(<LensMetricsView surface={metrics} />);
    const confirmed = document.querySelector(".lens-metrics-hyp-verdict.confirmed");
    expect(confirmed).not.toBeNull();
  });

  it("Inferred verdict gets inferred class", () => {
    render(<LensMetricsView surface={metrics} />);
    const inferred = document.querySelector(".lens-metrics-hyp-verdict.inferred");
    expect(inferred).not.toBeNull();
  });

  it("each hyp-group carries data-proof attribute", () => {
    render(<LensMetricsView surface={metrics} />);
    const groups = document.querySelectorAll(".lens-metrics-hyp-group[data-proof]");
    expect(groups.length).toBe(metrics.hypotheses.length);
  });

  it("each hyp-group carries data-target-id matching hypothesis id", () => {
    render(<LensMetricsView surface={metrics} />);
    for (const hyp of metrics.hypotheses) {
      const el = document.querySelector(`[data-target-id="${hyp.id}"]`);
      expect(el).not.toBeNull();
    }
  });

  it("renders empty state when no hypotheses", () => {
    render(<LensMetricsView surface={{ hypotheses: [] }} />);
    expect(screen.getByText(/metric hypotheses are sparse/i)).toBeInTheDocument();
  });
});

describe("LensMetricsView — proof highlight", () => {
  it("mock useSearch with proof='trigger' → trigger group gets proof-highlight class", () => {
    mockSearchState = { ...mockSearchState, proof: "trigger" };
    render(<LensMetricsView surface={metrics} />);
    const highlighted = document.querySelector(
      ".lens-metrics-hyp-group.proof-highlight",
    );
    expect(highlighted).not.toBeNull();
    expect(highlighted).toHaveAttribute("data-proof", "trigger");
  });

  it("mock useSearch with targetId matching group.id → group gets proof-highlight class", () => {
    mockSearchState = { ...mockSearchState, targetId: "hyp-trigger" };
    render(<LensMetricsView surface={metrics} />);
    const highlighted = document.querySelector(
      ".lens-metrics-hyp-group.proof-highlight",
    );
    expect(highlighted).not.toBeNull();
    expect(highlighted).toHaveAttribute("data-target-id", "hyp-trigger");
  });
});

// ── LogsView ───────────────────────────────────────────────────

describe("LensLogsView", () => {
  it("renders claim clusters", () => {
    render(<LensLogsView surface={logs} />);
    const clusters = document.querySelectorAll(".lens-logs-claim-cluster");
    expect(clusters.length).toBe(logs.claims.length);
  });

  it("marks signal entries with signal class", () => {
    render(<LensLogsView surface={logs} />);
    const signals = document.querySelectorAll(".lens-logs-log-row.signal");
    const totalSignals = logs.claims.flatMap((c) => c.entries).filter((e) => e.signal).length;
    expect(signals.length).toBe(totalSignals);
  });

  it("marks non-signal entries with noise class", () => {
    render(<LensLogsView surface={logs} />);
    const noise = document.querySelectorAll(".lens-logs-log-row.noise");
    const totalNoise = logs.claims.flatMap((c) => c.entries).filter((e) => !e.signal).length;
    expect(noise.length).toBe(totalNoise);
  });

  it("renders absence evidence cluster with absence class", () => {
    render(<LensLogsView surface={logs} />);
    const absenceClusters = document.querySelectorAll(".lens-logs-claim-cluster.absence");
    expect(absenceClusters.length).toBeGreaterThan(0);
  });

  it("renders absence evidence body with italic expected/observed text", () => {
    render(<LensLogsView surface={logs} />);
    const absenceText = document.querySelector(".lens-logs-absence-text");
    expect(absenceText).not.toBeNull();
    expect(absenceText?.textContent).toMatch(/expected/i);
    expect(absenceText?.textContent).toMatch(/observed: none/i);
  });

  it("absence cluster has teal header", () => {
    render(<LensLogsView surface={logs} />);
    const absenceHeader = document.querySelector(".lens-logs-claim-header.absence");
    expect(absenceHeader).not.toBeNull();
  });

  it("shows claim labels", () => {
    render(<LensLogsView surface={logs} />);
    for (const claim of logs.claims) {
      expect(screen.getAllByText(claim.label).length).toBeGreaterThan(0);
    }
  });

  it("shows entry count badges", () => {
    render(<LensLogsView surface={logs} />);
    const counts = document.querySelectorAll(".lens-logs-claim-count");
    expect(counts.length).toBe(logs.claims.length);
  });

  it("severity badges are colored for error", () => {
    render(<LensLogsView surface={logs} />);
    const errorSev = document.querySelector(".lens-logs-log-sev-error");
    expect(errorSev).not.toBeNull();
  });

  it("severity badges are colored for warn", () => {
    render(<LensLogsView surface={logs} />);
    const warnSev = document.querySelector(".lens-logs-log-sev-warn");
    expect(warnSev).not.toBeNull();
  });

  it("each claim cluster carries data-proof attribute", () => {
    render(<LensLogsView surface={logs} />);
    const clusters = document.querySelectorAll(".lens-logs-claim-cluster[data-proof]");
    expect(clusters.length).toBe(logs.claims.length);
  });

  it("each claim cluster carries data-target-id matching claim id", () => {
    render(<LensLogsView surface={logs} />);
    for (const claim of logs.claims) {
      const el = document.querySelector(`[data-target-id="${claim.id}"]`);
      expect(el).not.toBeNull();
    }
  });

  it("renders empty state when no claims", () => {
    render(<LensLogsView surface={{ claims: [] }} />);
    expect(screen.getByText(/log evidence is currently sparse/i)).toBeInTheDocument();
  });
});

describe("LensLogsView — proof highlight", () => {
  it("mock useSearch with proof='trigger' → trigger cluster gets proof-highlight class", () => {
    mockSearchState = { ...mockSearchState, proof: "trigger" };
    render(<LensLogsView surface={logs} />);
    const highlighted = document.querySelector(
      ".lens-logs-claim-cluster.proof-highlight",
    );
    expect(highlighted).not.toBeNull();
    expect(highlighted).toHaveAttribute("data-proof", "trigger");
  });

  it("mock useSearch with targetId matching claim.id → cluster gets proof-highlight class", () => {
    mockSearchState = { ...mockSearchState, targetId: "claim-429" };
    render(<LensLogsView surface={logs} />);
    const highlighted = document.querySelector(
      ".lens-logs-claim-cluster.proof-highlight",
    );
    expect(highlighted).not.toBeNull();
    expect(highlighted).toHaveAttribute("data-target-id", "claim-429");
  });
});

// ── Degraded states — sparse fixture ──────────────────────────

describe("Degraded states — sparse fixture", () => {
  it("TracesView with baselineState='unavailable' shows 'Expected trace unavailable' label", () => {
    render(
      <LensTracesView
        surface={evidenceSparse.surfaces.traces}
        baselineState="unavailable"
      />,
    );
    expect(screen.getByRole("button", { name: /expected trace unavailable/i })).toBeInTheDocument();
  });

  it("TracesView sparse: baseline toggle is aria-disabled='true'", () => {
    render(
      <LensTracesView
        surface={evidenceSparse.surfaces.traces}
        baselineState="unavailable"
      />,
    );
    const toggle = screen.getByRole("button", { name: /expected trace unavailable/i });
    expect(toggle).toHaveAttribute("aria-disabled", "true");
  });

  it("MetricsView with evidenceDensity='empty' shows reserved lane text", () => {
    render(
      <LensMetricsView
        surface={{ hypotheses: [] }}
        evidenceDensity="empty"
      />,
    );
    expect(screen.getByText(/metric lane is reserved/i)).toBeInTheDocument();
  });

  it("LogsView with evidenceDensity='empty' shows reserved lane text", () => {
    render(
      <LensLogsView
        surface={{ claims: [] }}
        evidenceDensity="empty"
      />,
    );
    expect(screen.getByText(/log lane is reserved/i)).toBeInTheDocument();
  });
});

// ── Degraded states — QA ──────────────────────────────────────

describe("Degraded states — QA", () => {
  it("QAFrame with noAnswerReason renders placeholder answer", () => {
    render(
      <QAFrame
        qa={evidenceSparse.qa}
        inputValue={evidenceSparse.qa.question}
        isSubmitting={false}
        onInputChange={vi.fn()}
        onSubmitQuestion={vi.fn()}
      />,
    );
    expect(screen.getByText(evidenceSparse.qa.noAnswerReason!)).toBeInTheDocument();
  });

  it("pending follow-up chips are still rendered", () => {
    render(
      <QAFrame
        qa={evidenceSparse.qa}
        inputValue={evidenceSparse.qa.question}
        isSubmitting={false}
        onInputChange={vi.fn()}
        onSubmitQuestion={vi.fn()}
      />,
    );
    const chips = document.querySelectorAll(".lens-ev-qa-chip");
    expect(chips.length).toBeGreaterThan(0);
  });

  it("follow-up chips are disabled when isSubmitting=true", () => {
    render(
      <QAFrame
        qa={evidenceSparse.qa}
        inputValue={evidenceSparse.qa.question}
        isSubmitting={true}
        onInputChange={vi.fn()}
        onSubmitQuestion={vi.fn()}
      />,
    );
    const chips = document.querySelectorAll(".lens-ev-qa-chip");
    chips.forEach((chip) => {
      expect(chip).toBeDisabled();
    });
  });
});
