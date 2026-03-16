import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ImpactTimeline } from "../components/board/ImpactTimeline.js";
import { buildIncidentWorkspaceVM } from "../lib/viewmodels/index.js";
import { testIncident } from "./fixtures.js";
import type { ImpactTimelineVM } from "../lib/viewmodels/index.js";

const vm = buildIncidentWorkspaceVM(testIncident)!;

describe("ImpactTimeline", () => {
  it("renders timeline events as timeline-row elements", () => {
    render(<ImpactTimeline timeline={vm.timeline} />);
    const rows = document.querySelectorAll(".timeline-row");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBe(vm.timeline.events.length);
  });

  it("shows time in .tt and label in .te", () => {
    render(<ImpactTimeline timeline={vm.timeline} />);
    const firstTime = document.querySelector(".tt");
    const firstEvent = document.querySelector(".te");
    expect(firstTime?.textContent).toBe(vm.timeline.events[0]?.time);
    expect(firstEvent?.textContent).toBe(vm.timeline.events[0]?.label);
  });

  it("renders surface text", () => {
    render(<ImpactTimeline timeline={vm.timeline} />);
    expect(screen.getByText(/Surface:/)).toBeInTheDocument();
  });

  it("renders empty list when events is empty", () => {
    const empty: ImpactTimelineVM = { events: [], surface: "" };
    render(<ImpactTimeline timeline={empty} />);
    expect(document.querySelectorAll(".timeline-row")).toHaveLength(0);
  });

  it("hides surface when empty string", () => {
    const noSurface: ImpactTimelineVM = {
      events: [{ time: "03:00:00", label: "test" }],
      surface: "",
    };
    render(<ImpactTimeline timeline={noSurface} />);
    expect(screen.queryByText(/Surface:/)).toBeNull();
  });

  it("has correct data-section attribute", () => {
    render(<ImpactTimeline timeline={vm.timeline} />);
    expect(
      document.querySelector("[data-section='impact-timeline']"),
    ).not.toBeNull();
  });

  it("renders card title", () => {
    render(<ImpactTimeline timeline={vm.timeline} />);
    expect(screen.getByText("Impact & Timeline")).toBeInTheDocument();
  });
});
