import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { LogsView } from "../components/evidence/LogsView.js";
import { testIncident } from "./fixtures.js";
import type { RelevantLog } from "@3amoncall/core";
import type { Incident } from "../api/types.js";

const withLogs = (logs: RelevantLog[]): Incident => ({
  ...testIncident,
  packet: {
    ...testIncident.packet,
    evidence: {
      ...testIncident.packet.evidence,
      relevantLogs: logs,
    },
  },
});

describe("LogsView", () => {
  it("shows EmptyView when relevantLogs is empty", () => {
    render(<LogsView incident={testIncident} />);
    expect(
      screen.getByText("No log record data available for this incident."),
    ).toBeInTheDocument();
  });

  it("renders relevantLogs entries as log rows", () => {
    const incident = withLogs([
      { timestamp: "2026-03-09T03:00:12Z", severity: "ERROR", service: "web", body: "DB timeout", environment: "production", startTimeMs: 1772690412000, attributes: {} },
      { timestamp: "2026-03-09T03:00:45Z", severity: "WARN", service: "api", body: "Retry limit", environment: "production", startTimeMs: 1772690445000, attributes: {} },
    ]);
    render(<LogsView incident={incident} />);
    const rows = document.querySelectorAll(".log-row");
    expect(rows).toHaveLength(2);
  });

  it("shows service in .lr-svc", () => {
    const incident = withLogs([
      { timestamp: "2026-03-09T03:00:12Z", severity: "ERROR", service: "stripe", body: "429", environment: "production", startTimeMs: 1772690412000, attributes: {} },
    ]);
    render(<LogsView incident={incident} />);
    expect(document.querySelector(".lr-svc")?.textContent).toBe("stripe");
  });

  it("shows ERROR level class for ERROR severity", () => {
    const incident = withLogs([
      { timestamp: "2026-03-09T03:00:12Z", severity: "ERROR", service: "web", body: "fail", environment: "production", startTimeMs: 1772690412000, attributes: {} },
    ]);
    render(<LogsView incident={incident} />);
    expect(document.querySelector(".lr-level")).toHaveClass("level-error");
    expect(document.querySelector(".lr-level")?.textContent).toBe("ERROR");
  });

  it("shows WARN level class for WARN severity", () => {
    const incident = withLogs([
      { timestamp: "2026-03-09T03:00:12Z", severity: "WARN", service: "web", body: "slow", environment: "production", startTimeMs: 1772690412000, attributes: {} },
    ]);
    render(<LogsView incident={incident} />);
    expect(document.querySelector(".lr-level")).toHaveClass("level-warn");
    expect(document.querySelector(".lr-level")?.textContent).toBe("WARN");
  });
});
