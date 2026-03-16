import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import { LogsView } from "../components/evidence/LogsView.js";
import { testLog1, testLog2 } from "./fixtures.js";
import type { RelevantLog } from "@3amoncall/core";

describe("LogsView", () => {
  it("shows empty state when no logs", () => {
    render(<LogsView rawLogs={[]} packetLogs={[]} />);
    expect(
      screen.getByText("No log record data available for this incident."),
    ).toBeInTheDocument();
  });

  it("renders log rows", () => {
    render(<LogsView rawLogs={[testLog1, testLog2]} packetLogs={[]} />);
    expect(screen.getAllByTestId("log-row")).toHaveLength(2);
  });

  it("renders log body text", () => {
    render(<LogsView rawLogs={[testLog1]} packetLogs={[]} />);
    expect(screen.getByText("Stripe API returned 429 Too Many Requests")).toBeInTheDocument();
  });

  it("shows ERROR severity class", () => {
    render(<LogsView rawLogs={[testLog1]} packetLogs={[]} />);
    expect(document.querySelector(".lr-level")).toHaveClass("lr-error");
    expect(document.querySelector(".lr-level")?.textContent).toBe("ERROR");
  });

  it("shows WARN severity class", () => {
    render(<LogsView rawLogs={[testLog2]} packetLogs={[]} />);
    expect(document.querySelector(".lr-level")).toHaveClass("lr-warn");
    expect(document.querySelector(".lr-level")?.textContent).toBe("WARN");
  });

  it("renders service name in .lr-svc", () => {
    render(<LogsView rawLogs={[testLog1]} packetLogs={[]} />);
    expect(document.querySelector(".lr-svc")?.textContent).toBe("web");
  });

  it("highlights logs matching packetLogs", () => {
    render(<LogsView rawLogs={[testLog1, testLog2]} packetLogs={[testLog1]} />);
    const highlighted = document.querySelectorAll(".log-row.highlighted");
    expect(highlighted).toHaveLength(1);
  });

  it("renders severity filter buttons", () => {
    render(<LogsView rawLogs={[testLog1, testLog2]} packetLogs={[]} />);
    const filters = screen.getAllByTestId("severity-filter");
    expect(filters.length).toBeGreaterThan(0);
  });

  it("renders service chips", () => {
    render(<LogsView rawLogs={[testLog1, testLog2]} packetLogs={[]} />);
    const chips = screen.getAllByTestId("service-chip");
    expect(chips.length).toBeGreaterThan(0);
  });

  it("expands log attrs on click when attributes exist", async () => {
    const user = userEvent.setup();
    render(<LogsView rawLogs={[testLog1]} packetLogs={[]} />);
    const row = screen.getByTestId("log-row");
    await user.click(row);
    expect(screen.getByTestId("log-attrs")).toBeInTheDocument();
  });

  it("does not show log attrs for logs with empty attributes", () => {
    const logNoAttrs: RelevantLog = {
      ...testLog2,
      attributes: {},
    };
    render(<LogsView rawLogs={[logNoAttrs]} packetLogs={[]} />);
    expect(document.querySelectorAll(".log-attrs")).toHaveLength(0);
  });
});
