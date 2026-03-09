import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { WhatHappened } from "../components/board/WhatHappened.js";
import { testIncident, testIncidentNoDiagnosis } from "./fixtures.js";

describe("WhatHappened", () => {
  it("renders headline from diagnosisResult.summary.what_happened", () => {
    render(<WhatHappened incident={testIncident} />);
    expect(
      screen.getByText(/Stripe API rate limiting caused cascading/),
    ).toBeInTheDocument();
  });

  it("renders impact chips", () => {
    render(<WhatHappened incident={testIncident} />);
    expect(screen.getByText("customer-facing")).toBeInTheDocument();
    expect(screen.getByText("external dependency")).toBeInTheDocument();
    expect(screen.getByText("confidence: high")).toBeInTheDocument();
  });

  it("returns null when no diagnosisResult", () => {
    const { container } = render(
      <WhatHappened incident={testIncidentNoDiagnosis} />,
    );
    expect(container.innerHTML).toBe("");
  });
});
