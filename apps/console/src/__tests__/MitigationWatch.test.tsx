import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { MitigationWatch } from "../components/board/MitigationWatch.js";
import { testDiagnosis } from "./fixtures.js";

describe("MitigationWatch", () => {
  it("renders watch_items", () => {
    render(<MitigationWatch diagnosisResult={testDiagnosis} />);
    expect(screen.getByText("Error rate")).toBeInTheDocument();
    expect(screen.getByText("52%")).toBeInTheDocument();
    expect(screen.getByText("Stripe 429s")).toBeInTheDocument();
    expect(screen.getByText("rising")).toBeInTheDocument();
    expect(screen.getByText("Queue depth")).toBeInTheDocument();
  });

  it("applies correct CSS status class", () => {
    render(<MitigationWatch diagnosisResult={testDiagnosis} />);
    const statusElements = document.querySelectorAll(".ws");
    // alert -> ws-lagging
    expect(statusElements[0]?.classList.contains("ws-lagging")).toBe(true);
    // watch -> ws-watch
    expect(statusElements[1]?.classList.contains("ws-watch")).toBe(true);
    // ok -> ws-next
    expect(statusElements[2]?.classList.contains("ws-next")).toBe(true);
  });
});
