import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { CausalChain } from "../components/board/CausalChain.js";
import { testDiagnosis } from "./fixtures.js";

describe("CausalChain", () => {
  const steps = testDiagnosis.reasoning.causal_chain;

  it("renders correct number of steps", () => {
    render(<CausalChain steps={steps} />);
    const stepElements = document.querySelectorAll(".chain-step");
    expect(stepElements).toHaveLength(4);
  });

  it("each step has correct data-type attribute", () => {
    render(<CausalChain steps={steps} />);
    const stepElements = document.querySelectorAll(".chain-step");
    expect(stepElements[0]?.getAttribute("data-type")).toBe("external");
    expect(stepElements[1]?.getAttribute("data-type")).toBe("system");
    expect(stepElements[2]?.getAttribute("data-type")).toBe("incident");
    expect(stepElements[3]?.getAttribute("data-type")).toBe("impact");
  });

  it("renders correct number of connectors (steps - 1)", () => {
    render(<CausalChain steps={steps} />);
    const connectors = document.querySelectorAll(".chain-connector");
    expect(connectors).toHaveLength(3);
  });

  it("renders step titles", () => {
    render(<CausalChain steps={steps} />);
    expect(screen.getByText("Stripe rate limit hit")).toBeInTheDocument();
    expect(screen.getByText("Retry storms")).toBeInTheDocument();
    expect(screen.getByText("Checkout failures")).toBeInTheDocument();
    expect(screen.getByText("Revenue loss")).toBeInTheDocument();
  });
});
