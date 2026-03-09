import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { LogsView } from "../components/evidence/LogsView.js";
import { testIncident } from "./fixtures.js";
import type { Incident } from "../api/types.js";

describe("LogsView", () => {
  it("renders triggerSignals as log rows", () => {
    render(<LogsView incident={testIncident} />);
    const rows = document.querySelectorAll(".log-row");
    expect(rows).toHaveLength(2);
  });

  it("shows entity in .lr-svc", () => {
    render(<LogsView incident={testIncident} />);
    const svcCells = document.querySelectorAll(".lr-svc");
    const texts = Array.from(svcCells).map((el) => el.textContent);
    expect(texts).toContain("stripe");
    expect(texts).toContain("web");
  });

  it("shows ERROR level for 429 signal", () => {
    render(<LogsView incident={testIncident} />);
    // First signal is "HTTP 429"
    const levelCells = document.querySelectorAll(".lr-level");
    expect(levelCells[0]).toHaveClass("level-error");
    expect(levelCells[0].textContent).toBe("ERROR");
  });

  it("shows WARN level for other signals", () => {
    render(<LogsView incident={testIncident} />);
    // Second signal is "error_rate > 50%" — contains "error" so it should be ERROR too
    // Let's test with a signal that has no 429/error keyword
    const noErrorIncident: Incident = {
      ...testIncident,
      packet: {
        ...testIncident.packet,
        triggerSignals: [
          {
            signal: "latency_p99 > 3000ms",
            firstSeenAt: "2026-03-09T03:00:00Z",
            entity: "api",
          },
        ],
      },
    };
    render(<LogsView incident={noErrorIncident} />);
    const levelCells = document.querySelectorAll(".lr-level");
    // The last rendered one is WARN
    const lastLevel = levelCells[levelCells.length - 1];
    expect(lastLevel).toHaveClass("level-warn");
    expect(lastLevel.textContent).toBe("WARN");
  });

  it("shows EmptyView when no triggerSignals", () => {
    const emptyIncident: Incident = {
      ...testIncident,
      packet: {
        ...testIncident.packet,
        triggerSignals: [],
      },
    };
    render(<LogsView incident={emptyIncident} />);
    expect(
      screen.getByText("No trigger signal data available for this incident."),
    ).toBeInTheDocument();
  });
});
