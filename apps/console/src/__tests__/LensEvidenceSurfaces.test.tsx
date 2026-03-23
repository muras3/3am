import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { LensTracesView } from "../components/lens/evidence/LensTracesView.js";
import { LensMetricsView } from "../components/lens/evidence/LensMetricsView.js";
import { LensLogsView } from "../components/lens/evidence/LensLogsView.js";
import { evidenceReady } from "../__fixtures__/curated/evidence.js";

vi.mock("@tanstack/react-router", () => ({
  useSearch: () => ({
    level: 2,
    tab: "traces",
    incidentId: "inc_0892",
  }),
}));

const { traces, metrics, logs } = evidenceReady.surfaces;

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

  it("expandable span detail is hidden by default", () => {
    render(<LensTracesView surface={traces} />);
    // Details should exist but not be visible (no .open class)
    const openDetails = document.querySelectorAll(".lens-traces-span-detail.open");
    // None should be open initially
    expect(openDetails.length).toBe(0);
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
