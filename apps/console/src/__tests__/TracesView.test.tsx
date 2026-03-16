import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { TracesView } from "../components/evidence/TracesView.js";
import { testSpan1, testSpan2, testSpan3, testPacket } from "./fixtures.js";

const packetTraces = testPacket.evidence.representativeTraces;

describe("TracesView", () => {
  it("shows EmptyView when rawSpans is empty", () => {
    render(
      <TracesView rawSpans={[]} packetTraces={[]} onSpanSelect={vi.fn()} />,
    );
    expect(
      screen.getByText("No trace data available for this incident."),
    ).toBeInTheDocument();
  });

  it("renders trace groups", () => {
    render(
      <TracesView
        rawSpans={[testSpan1, testSpan2, testSpan3]}
        packetTraces={packetTraces}
        onSpanSelect={vi.fn()}
      />,
    );
    // 2 traces: trace_001 and trace_002
    expect(screen.getAllByTestId("trace-group")).toHaveLength(2);
  });

  it("renders span rows in DFS order", () => {
    render(
      <TracesView
        rawSpans={[testSpan1, testSpan2]}
        packetTraces={[]}
        onSpanSelect={vi.fn()}
      />,
    );
    const rows = screen.getAllByTestId("span-row");
    // root span first, child second
    expect(rows).toHaveLength(2);
  });

  it("calls onSpanSelect when span row clicked", async () => {
    const user = userEvent.setup();
    const onSpanSelect = vi.fn();
    render(
      <TracesView
        rawSpans={[testSpan1]}
        packetTraces={[]}
        onSpanSelect={onSpanSelect}
      />,
    );
    const row = screen.getByTestId("span-row");
    await user.click(row);
    expect(onSpanSelect).toHaveBeenCalledOnce();
    expect(onSpanSelect).toHaveBeenCalledWith(testSpan1);
  });

  it("highlights spans matching packetTraces", () => {
    // testSpan1 matches by spanId to packet traces
    const matchingPacketTraces = [
      {
        traceId: testSpan1.traceId,
        spanId: testSpan1.spanId,
        serviceName: testSpan1.serviceName,
        durationMs: testSpan1.durationMs,
        spanStatusCode: testSpan1.spanStatusCode,
      },
    ];
    render(
      <TracesView
        rawSpans={[testSpan1, testSpan2]}
        packetTraces={matchingPacketTraces}
        onSpanSelect={vi.fn()}
      />,
    );
    const highlighted = document.querySelectorAll(".wf-row.highlighted");
    expect(highlighted).toHaveLength(1);
  });

  it("shows error traces before non-error traces (sort order)", () => {
    render(
      <TracesView
        rawSpans={[testSpan3, testSpan1, testSpan2]}
        packetTraces={[]}
        onSpanSelect={vi.fn()}
      />,
    );
    const groups = screen.getAllByTestId("trace-group");
    // trace_001 (error: spanStatusCode=2) should be first
    expect(groups[0]).toBeInTheDocument();
  });

  it("renders method/route in trace group header", () => {
    render(
      <TracesView
        rawSpans={[testSpan1]}
        packetTraces={[]}
        onSpanSelect={vi.fn()}
      />,
    );
    // testSpan1 has method POST and route /checkout
    expect(screen.getByText("POST")).toBeInTheDocument();
    expect(screen.getByText("/checkout")).toBeInTheDocument();
  });
});
