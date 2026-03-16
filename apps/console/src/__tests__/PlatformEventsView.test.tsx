import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { PlatformEventsView } from "../components/evidence/PlatformEventsView.js";
import {
  testPlatformEvent1,
  testPlatformEvent2,
  testPacket,
} from "./fixtures.js";

describe("PlatformEventsView", () => {
  it("renders empty state when no events", () => {
    render(
      <PlatformEventsView
        rawEvents={[]}
        packetEvents={[]}
        onEventSelect={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/No platform events captured/),
    ).toBeInTheDocument();
  });

  it("renders event items", () => {
    render(
      <PlatformEventsView
        rawEvents={[testPlatformEvent1, testPlatformEvent2]}
        packetEvents={[]}
        onEventSelect={vi.fn()}
      />,
    );
    expect(screen.getAllByTestId("pe-item")).toHaveLength(2);
  });

  it("renders event descriptions", () => {
    render(
      <PlatformEventsView
        rawEvents={[testPlatformEvent1, testPlatformEvent2]}
        packetEvents={[]}
        onEventSelect={vi.fn()}
      />,
    );
    expect(
      screen.getByText("Deployed web service v1.2.3"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Stripe API degraded performance"),
    ).toBeInTheDocument();
  });

  it("renders type badges", () => {
    render(
      <PlatformEventsView
        rawEvents={[testPlatformEvent1, testPlatformEvent2]}
        packetEvents={[]}
        onEventSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("deploy")).toBeInTheDocument();
    expect(screen.getByText("provider")).toBeInTheDocument();
  });

  it("highlights events matching packetEvents by eventId", () => {
    render(
      <PlatformEventsView
        rawEvents={[testPlatformEvent1, testPlatformEvent2]}
        packetEvents={[testPlatformEvent1]}
        onEventSelect={vi.fn()}
      />,
    );
    const highlighted = document.querySelectorAll(".pe-item.highlighted");
    expect(highlighted).toHaveLength(1);
  });

  it("does not highlight events not in packetEvents", () => {
    render(
      <PlatformEventsView
        rawEvents={[testPlatformEvent1, testPlatformEvent2]}
        packetEvents={[]}
        onEventSelect={vi.fn()}
      />,
    );
    const highlighted = document.querySelectorAll(".pe-item.highlighted");
    expect(highlighted).toHaveLength(0);
  });

  it("calls onEventSelect when event is clicked", async () => {
    const user = userEvent.setup();
    const onEventSelect = vi.fn();
    render(
      <PlatformEventsView
        rawEvents={[testPlatformEvent1]}
        packetEvents={[]}
        onEventSelect={onEventSelect}
      />,
    );
    await user.click(screen.getByText("Deployed web service v1.2.3"));
    expect(onEventSelect).toHaveBeenCalledOnce();
    expect(onEventSelect).toHaveBeenCalledWith(testPlatformEvent1);
  });

  it("renders color strip for each event type", () => {
    render(
      <PlatformEventsView
        rawEvents={[testPlatformEvent1, testPlatformEvent2]}
        packetEvents={[]}
        onEventSelect={vi.fn()}
      />,
    );
    const strips = document.querySelectorAll(".pe-strip");
    expect(strips).toHaveLength(2);
  });

  it("uses packet events from packet for comparison (graceful)", () => {
    // packetEvents from packet.evidence.platformEvents (empty in test packet)
    render(
      <PlatformEventsView
        rawEvents={[testPlatformEvent1]}
        packetEvents={testPacket.evidence.platformEvents}
        onEventSelect={vi.fn()}
      />,
    );
    // No highlights since packet has no platform events
    expect(document.querySelectorAll(".pe-item.highlighted")).toHaveLength(0);
  });
});
