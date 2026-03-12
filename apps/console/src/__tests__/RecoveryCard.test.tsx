import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { RecoveryCard } from "../components/board/RecoveryCard.js";
import { buildIncidentWorkspaceVM } from "../lib/viewmodels/index.js";
import { testIncident } from "./fixtures.js";

const vm = buildIncidentWorkspaceVM(testIncident)!;

describe("RecoveryCard", () => {
  it("renders watch_items mapped from RecoveryVM", () => {
    render(<RecoveryCard recovery={vm.recovery} />);
    expect(screen.getByText("Error rate")).toBeInTheDocument();
    expect(screen.getByText("52%")).toBeInTheDocument();
    expect(screen.getByText("Stripe 429s")).toBeInTheDocument();
    expect(screen.getByText("rising")).toBeInTheDocument();
    expect(screen.getByText("Queue depth")).toBeInTheDocument();
  });

  it("applies correct CSS status class", () => {
    render(<RecoveryCard recovery={vm.recovery} />);
    const statusElements = document.querySelectorAll(".ws");
    // alert -> ws-lagging
    expect(statusElements[0]?.classList.contains("ws-lagging")).toBe(true);
    // watch -> ws-watch
    expect(statusElements[1]?.classList.contains("ws-watch")).toBe(true);
    // ok -> ws-next
    expect(statusElements[2]?.classList.contains("ws-next")).toBe(true);
  });

  it("has correct data-section attribute", () => {
    render(<RecoveryCard recovery={vm.recovery} />);
    expect(document.querySelector("[data-section='recovery']")).not.toBeNull();
  });

  it("renders empty list when items is empty", () => {
    render(<RecoveryCard recovery={{ items: [] }} />);
    expect(document.querySelectorAll(".watch-row")).toHaveLength(0);
  });
});
