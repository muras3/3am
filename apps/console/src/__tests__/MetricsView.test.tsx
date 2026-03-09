import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { MetricsView } from "../components/evidence/MetricsView.js";
import { testIncident, testIncidentNoDiagnosis } from "./fixtures.js";

describe("MetricsView", () => {
  it("renders 'No metrics data' text", () => {
    render(<MetricsView incident={testIncident} />);
    expect(
      screen.getByText(
        "No metrics data — will appear when /v1/metrics ingest is active",
      ),
    ).toBeInTheDocument();
  });

  it("renders correctly with incident that has no diagnosisResult", () => {
    render(<MetricsView incident={testIncidentNoDiagnosis} />);
    expect(
      screen.getByText(
        "No metrics data — will appear when /v1/metrics ingest is active",
      ),
    ).toBeInTheDocument();
    expect(document.querySelector(".ev-empty-metrics")).toBeInTheDocument();
  });
});
