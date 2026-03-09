import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { EvidenceStudio } from "../components/evidence/EvidenceStudio.js";
import { testIncident } from "./fixtures.js";

describe("EvidenceStudio", () => {
  it("renders modal when mounted", () => {
    render(<EvidenceStudio incident={testIncident} onClose={vi.fn()} />);
    expect(screen.getByText("Evidence Studio")).toBeInTheDocument();
    expect(screen.getByText("web evidence")).toBeInTheDocument();
  });

  it("calls onClose when ESC key pressed", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<EvidenceStudio incident={testIncident} onClose={onClose} />);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when Close button clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<EvidenceStudio incident={testIncident} onClose={onClose} />);
    await user.click(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows TracesView when traces tab is active", () => {
    render(<EvidenceStudio incident={testIncident} onClose={vi.fn()} />);
    // Default tab is traces
    const rows = document.querySelectorAll(".trace-attrs-row");
    expect(rows.length).toBeGreaterThan(0);
  });

  it("shows EmptyView for metrics tab", async () => {
    const user = userEvent.setup();
    render(<EvidenceStudio incident={testIncident} onClose={vi.fn()} />);
    await user.click(screen.getByText("Metrics"));
    expect(
      screen.getByText("No metrics data available for this incident."),
    ).toBeInTheDocument();
  });
});
