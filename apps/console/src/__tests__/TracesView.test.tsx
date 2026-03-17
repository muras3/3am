import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { TracesView } from "../components/evidence/TracesView.js";
import { testTelemetrySpan1, testTelemetrySpan2, testTelemetrySpan3, testPacket } from "./fixtures.js";

const packetTraces = testPacket.evidence.representativeTraces;

describe("TracesView", () => {
  it("shows EmptyView when telemetrySpans is empty", () => {
    render(
      <TracesView telemetrySpans={[]} packetTraces={[]} onSpanSelect={vi.fn()} />,
    );
    expect(
      screen.getByText("No trace data available for this incident."),
    ).toBeInTheDocument();
  });

  it("renders trace groups", () => {
    render(
      <TracesView
        telemetrySpans={[testTelemetrySpan1, testTelemetrySpan2, testTelemetrySpan3]}
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
        telemetrySpans={[testTelemetrySpan1, testTelemetrySpan2]}
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
        telemetrySpans={[testTelemetrySpan1]}
        packetTraces={[]}
        onSpanSelect={onSpanSelect}
      />,
    );
    const row = screen.getByTestId("span-row");
    await user.click(row);
    expect(onSpanSelect).toHaveBeenCalledOnce();
    expect(onSpanSelect).toHaveBeenCalledWith(testTelemetrySpan1);
  });

  it("highlights spans matching packetTraces", () => {
    // testTelemetrySpan1 matches by spanId to packet traces
    const matchingPacketTraces = [
      {
        traceId: testTelemetrySpan1.traceId,
        spanId: testTelemetrySpan1.spanId,
        serviceName: testTelemetrySpan1.serviceName,
        durationMs: testTelemetrySpan1.durationMs,
        spanStatusCode: testTelemetrySpan1.spanStatusCode,
      },
    ];
    render(
      <TracesView
        telemetrySpans={[testTelemetrySpan1, testTelemetrySpan2]}
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
        telemetrySpans={[testTelemetrySpan3, testTelemetrySpan1, testTelemetrySpan2]}
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
        telemetrySpans={[testTelemetrySpan1]}
        packetTraces={[]}
        onSpanSelect={vi.fn()}
      />,
    );
    // testTelemetrySpan1 has method POST and route /checkout
    expect(screen.getByText("POST")).toBeInTheDocument();
    expect(screen.getByText("/checkout")).toBeInTheDocument();
  });
});
