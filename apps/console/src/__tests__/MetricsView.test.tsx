import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { MetricsView } from "../components/evidence/MetricsView.js";
import { testMetric1, testMetric2 } from "./fixtures.js";

describe("MetricsView", () => {
  it("renders empty state when no metrics", () => {
    render(
      <MetricsView rawMetrics={[]} packetMetrics={[]} onMetricSelect={vi.fn()} />,
    );
    expect(
      screen.getByText("No metric data available for this incident."),
    ).toBeInTheDocument();
  });

  it("renders metrics table rows", () => {
    render(
      <MetricsView
        rawMetrics={[testMetric1, testMetric2]}
        packetMetrics={[]}
        onMetricSelect={vi.fn()}
      />,
    );
    expect(screen.getAllByTestId("metric-row")).toHaveLength(2);
  });

  it("renders stat cards", () => {
    render(
      <MetricsView
        rawMetrics={[testMetric1, testMetric2]}
        packetMetrics={[]}
        onMetricSelect={vi.fn()}
      />,
    );
    expect(screen.getAllByTestId("stat-card").length).toBeGreaterThan(0);
  });

  it("highlights rows from packetMetrics", () => {
    render(
      <MetricsView
        rawMetrics={[testMetric1, testMetric2]}
        packetMetrics={[testMetric1]}
        onMetricSelect={vi.fn()}
      />,
    );
    const highlighted = document.querySelectorAll(".mt-row.highlighted");
    expect(highlighted).toHaveLength(1);
  });

  it("calls onMetricSelect when row clicked", async () => {
    const user = userEvent.setup();
    const onMetricSelect = vi.fn();
    render(
      <MetricsView
        rawMetrics={[testMetric1]}
        packetMetrics={[]}
        onMetricSelect={onMetricSelect}
      />,
    );
    await user.click(document.querySelector(".mt-row")!);
    expect(onMetricSelect).toHaveBeenCalledOnce();
    expect(onMetricSelect).toHaveBeenCalledWith(testMetric1);
  });

  it("renders metric name and service", () => {
    render(
      <MetricsView
        rawMetrics={[testMetric1]}
        packetMetrics={[]}
        onMetricSelect={vi.fn()}
      />,
    );
    expect(screen.getAllByText("http_server_request_duration").length).toBeGreaterThan(0);
    expect(screen.getAllByText("web").length).toBeGreaterThan(0);
  });
});
