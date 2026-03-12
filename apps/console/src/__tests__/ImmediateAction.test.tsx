import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ImmediateAction } from "../components/board/ImmediateAction.js";
import { buildIncidentWorkspaceVM } from "../lib/viewmodels/index.js";
import { testIncident } from "./fixtures.js";

const vm = buildIncidentWorkspaceVM(testIncident)!;

describe("ImmediateAction", () => {
  it("renders immediate_action text", () => {
    render(<ImmediateAction action={vm.action} />);
    expect(
      screen.getByText(/Enable circuit breaker on Stripe client/),
    ).toBeInTheDocument();
  });

  it('renders action_rationale_short with "Why:"', () => {
    render(<ImmediateAction action={vm.action} />);
    expect(screen.getByText("Why:")).toBeInTheDocument();
    expect(
      screen.getByText(/Reduces blast radius by preventing retry storms/),
    ).toBeInTheDocument();
  });

  it("renders do_not when present", () => {
    render(<ImmediateAction action={vm.action} />);
    expect(screen.getByText("Do not:")).toBeInTheDocument();
    expect(
      screen.getByText(/Do not increase Stripe API concurrency/),
    ).toBeInTheDocument();
  });

  it("has correct data-section attribute", () => {
    render(<ImmediateAction action={vm.action} />);
    expect(document.querySelector("[data-section='action']")).not.toBeNull();
  });
});
