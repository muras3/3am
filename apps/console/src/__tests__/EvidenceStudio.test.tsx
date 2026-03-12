import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { EvidenceStudio } from "../components/evidence/EvidenceStudio.js";
import { buildEvidenceStudioVM } from "../lib/viewmodels/index.js";
import { testIncident } from "./fixtures.js";

const studioVM = buildEvidenceStudioVM(testIncident);

describe("EvidenceStudio", () => {
  it("renders modal when mounted", () => {
    render(
      <EvidenceStudio
        incident={testIncident}
        studioVM={studioVM}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Evidence Studio")).toBeInTheDocument();
    expect(screen.getByText("web evidence")).toBeInTheDocument();
  });

  it("calls onClose when ESC key pressed", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <EvidenceStudio
        incident={testIncident}
        studioVM={studioVM}
        onClose={onClose}
      />,
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when Close button clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <EvidenceStudio
        incident={testIncident}
        studioVM={studioVM}
        onClose={onClose}
      />,
    );
    await user.click(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows TracesView when traces tab is active", () => {
    render(
      <EvidenceStudio
        incident={testIncident}
        studioVM={studioVM}
        onClose={vi.fn()}
      />,
    );
    // Default tab is traces
    const rows = document.querySelectorAll(".trace-attrs-row");
    expect(rows.length).toBeGreaterThan(0);
  });

  it("shows MetricsView for metrics tab", async () => {
    const user = userEvent.setup();
    render(
      <EvidenceStudio
        incident={testIncident}
        studioVM={studioVM}
        onClose={vi.fn()}
      />,
    );
    await user.click(screen.getByText("Metrics"));
    expect(
      screen.getByText(
        "No metrics data — will appear when /v1/metrics ingest is active",
      ),
    ).toBeInTheDocument();
  });

  it("renders proof cards before tabs", () => {
    render(
      <EvidenceStudio
        incident={testIncident}
        studioVM={studioVM}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("proof-cards")).toBeInTheDocument();
    expect(screen.getAllByTestId("proof-card")).toHaveLength(3);
  });
});
