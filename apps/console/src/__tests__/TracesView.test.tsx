import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { TracesView } from "../components/evidence/TracesView.js";
import { testIncident } from "./fixtures.js";
import type { Incident } from "../api/types.js";

describe("TracesView", () => {
  it("renders table rows for each trace", () => {
    render(<TracesView incident={testIncident} />);
    const rows = document.querySelectorAll(".trace-attrs-row");
    expect(rows).toHaveLength(2);
    // service name appears in both waterfall and attrs table — use getAllByText
    expect(screen.getAllByText("web").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("api-gateway").length).toBeGreaterThanOrEqual(1);
  });

  it("shows duration and status details", () => {
    render(<TracesView incident={testIncident} />);
    // 5200ms appears in both waterfall (as a label) and attrs table
    expect(screen.getAllByText(/5200ms/).length).toBeGreaterThanOrEqual(1);
    // HTTP 429 only appears in the attrs table
    expect(screen.getByText(/HTTP 429/)).toBeInTheDocument();
  });

  it("renders waterfall rows, one per trace", () => {
    render(<TracesView incident={testIncident} />);
    const wfRows = document.querySelectorAll(".wf-row");
    expect(wfRows).toHaveLength(2);
  });

  it("waterfall row has correct service name", () => {
    render(<TracesView incident={testIncident} />);
    const wfRows = document.querySelectorAll(".wf-row");
    expect(wfRows[0].textContent).toContain("web");
    expect(wfRows[1].textContent).toContain("api-gateway");
  });

  it("shows EmptyView when traces is empty", () => {
    const emptyIncident: Incident = {
      ...testIncident,
      packet: {
        ...testIncident.packet,
        evidence: {
          ...testIncident.packet.evidence,
          representativeTraces: [],
        },
      },
    };
    render(<TracesView incident={emptyIncident} />);
    expect(
      screen.getByText("No trace data available for this incident."),
    ).toBeInTheDocument();
  });
});
