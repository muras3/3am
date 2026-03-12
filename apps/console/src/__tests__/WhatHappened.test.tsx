import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { WhatHappened } from "../components/board/WhatHappened.js";
import { buildIncidentWorkspaceVM } from "../lib/viewmodels/index.js";
import { testIncident } from "./fixtures.js";

const vm = buildIncidentWorkspaceVM(testIncident)!;

describe("WhatHappened", () => {
  it("renders headline from vm.headline", () => {
    render(<WhatHappened headline={vm.headline} chips={vm.chips} />);
    expect(
      screen.getByText(/Stripe API rate limiting caused cascading/),
    ).toBeInTheDocument();
  });

  it("renders impact chips from vm.chips", () => {
    render(<WhatHappened headline={vm.headline} chips={vm.chips} />);
    expect(screen.getByText("customer-facing")).toBeInTheDocument();
    expect(screen.getByText("external dependency")).toBeInTheDocument();
    expect(screen.getByText("confidence: high")).toBeInTheDocument();
  });

  it("has correct data-section attribute", () => {
    render(<WhatHappened headline={vm.headline} chips={vm.chips} />);
    expect(document.querySelector("[data-section='what-broke']")).not.toBeNull();
  });
});
