import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ImmediateAction } from "../components/board/ImmediateAction.js";
import { testDiagnosis } from "./fixtures.js";

describe("ImmediateAction", () => {
  it("renders immediate_action text", () => {
    render(<ImmediateAction diagnosisResult={testDiagnosis} />);
    expect(
      screen.getByText(/Enable circuit breaker on Stripe client/),
    ).toBeInTheDocument();
  });

  it('renders action_rationale_short with "Why:"', () => {
    render(<ImmediateAction diagnosisResult={testDiagnosis} />);
    expect(screen.getByText("Why:")).toBeInTheDocument();
    expect(
      screen.getByText(/Reduces blast radius by preventing retry storms/),
    ).toBeInTheDocument();
  });

  it("renders do_not when present", () => {
    render(<ImmediateAction diagnosisResult={testDiagnosis} />);
    expect(screen.getByText("Do not:")).toBeInTheDocument();
    expect(
      screen.getByText(/Do not increase Stripe API concurrency/),
    ).toBeInTheDocument();
  });
});
