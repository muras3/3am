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
    expect(screen.getByText("web")).toBeInTheDocument();
    expect(screen.getByText("api-gateway")).toBeInTheDocument();
  });

  it("shows duration and status details", () => {
    render(<TracesView incident={testIncident} />);
    expect(screen.getByText(/5200ms/)).toBeInTheDocument();
    expect(screen.getByText(/HTTP 429/)).toBeInTheDocument();
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
