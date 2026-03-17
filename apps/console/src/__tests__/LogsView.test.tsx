import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import { LogsView } from "../components/evidence/LogsView.js";
import { testTelemetryLog1, testTelemetryLog2, testLog1 } from "./fixtures.js";
import type { TelemetryLog } from "../api/types.js";

describe("LogsView", () => {
  it("shows empty state when no logs", () => {
    render(<LogsView telemetryLogs={[]} packetLogs={[]} />);
    expect(
      screen.getByText("No log record data available for this incident."),
    ).toBeInTheDocument();
  });

  it("renders log rows", () => {
    render(<LogsView telemetryLogs={[testTelemetryLog1, testTelemetryLog2]} packetLogs={[]} />);
    expect(screen.getAllByTestId("log-row")).toHaveLength(2);
  });

  it("renders log body text", () => {
    render(<LogsView telemetryLogs={[testTelemetryLog1]} packetLogs={[]} />);
    expect(screen.getByText("Stripe API returned 429 Too Many Requests")).toBeInTheDocument();
  });

  it("shows ERROR severity class", () => {
    render(<LogsView telemetryLogs={[testTelemetryLog1]} packetLogs={[]} />);
    expect(document.querySelector(".lr-level")).toHaveClass("lr-error");
    expect(document.querySelector(".lr-level")?.textContent).toBe("ERROR");
  });

  it("shows WARN severity class", () => {
    render(<LogsView telemetryLogs={[testTelemetryLog2]} packetLogs={[]} />);
    expect(document.querySelector(".lr-level")).toHaveClass("lr-warn");
    expect(document.querySelector(".lr-level")?.textContent).toBe("WARN");
  });

  it("renders service name in .lr-svc", () => {
    render(<LogsView telemetryLogs={[testTelemetryLog1]} packetLogs={[]} />);
    expect(document.querySelector(".lr-svc")?.textContent).toBe("web");
  });

  it("highlights logs matching packetLogs", () => {
    render(<LogsView telemetryLogs={[testTelemetryLog1, testTelemetryLog2]} packetLogs={[testLog1]} />);
    const highlighted = document.querySelectorAll(".log-row.highlighted");
    expect(highlighted).toHaveLength(1);
  });

  it("renders severity filter buttons", () => {
    render(<LogsView telemetryLogs={[testTelemetryLog1, testTelemetryLog2]} packetLogs={[]} />);
    const filters = screen.getAllByTestId("severity-filter");
    expect(filters.length).toBeGreaterThan(0);
  });

  it("renders service chips", () => {
    render(<LogsView telemetryLogs={[testTelemetryLog1, testTelemetryLog2]} packetLogs={[]} />);
    const chips = screen.getAllByTestId("service-chip");
    expect(chips.length).toBeGreaterThan(0);
  });

  it("expands log attrs on click when attributes exist", async () => {
    const user = userEvent.setup();
    render(<LogsView telemetryLogs={[testTelemetryLog1]} packetLogs={[]} />);
    const row = screen.getByTestId("log-row");
    await user.click(row);
    expect(screen.getByTestId("log-attrs")).toBeInTheDocument();
  });

  it("does not show log attrs for logs with empty attributes", () => {
    const logNoAttrs: TelemetryLog = {
      ...testTelemetryLog2,
      attributes: {},
    };
    render(<LogsView telemetryLogs={[logNoAttrs]} packetLogs={[]} />);
    expect(document.querySelectorAll(".log-attrs")).toHaveLength(0);
  });
});
