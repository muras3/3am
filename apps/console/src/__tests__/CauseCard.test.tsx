import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { CauseCard } from "../components/board/CauseCard.js";
import { buildIncidentWorkspaceVM } from "../lib/viewmodels/index.js";
import { testIncident } from "./fixtures.js";

const vm = buildIncidentWorkspaceVM(testIncident)!;

describe("CauseCard", () => {
  it("renders correct number of chain steps", () => {
    render(<CauseCard cause={vm.cause} />);
    const stepElements = document.querySelectorAll(".chain-step");
    expect(stepElements).toHaveLength(4);
  });

  it("each step has correct data-type attribute", () => {
    render(<CauseCard cause={vm.cause} />);
    const stepElements = document.querySelectorAll(".chain-step");
    expect(stepElements[0]?.getAttribute("data-type")).toBe("external");
    expect(stepElements[1]?.getAttribute("data-type")).toBe("system");
    expect(stepElements[2]?.getAttribute("data-type")).toBe("incident");
    expect(stepElements[3]?.getAttribute("data-type")).toBe("impact");
  });

  it("renders correct number of connectors (steps - 1)", () => {
    render(<CauseCard cause={vm.cause} />);
    const connectors = document.querySelectorAll(".chain-connector");
    expect(connectors).toHaveLength(3);
  });

  it("renders step titles", () => {
    render(<CauseCard cause={vm.cause} />);
    expect(screen.getByText("Stripe rate limit hit")).toBeInTheDocument();
    expect(screen.getByText("Retry storms")).toBeInTheDocument();
    expect(screen.getByText("Checkout failures")).toBeInTheDocument();
    expect(screen.getByText("Revenue loss")).toBeInTheDocument();
  });

  it("renders root cause hypothesis", () => {
    render(<CauseCard cause={vm.cause} />);
    expect(
      screen.getByText(/Flash sale traffic exceeded Stripe rate limits/),
    ).toBeInTheDocument();
  });

  it("has correct data-section attribute", () => {
    render(<CauseCard cause={vm.cause} />);
    expect(document.querySelector("[data-section='cause']")).not.toBeNull();
  });
});
