import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { SideRail } from "../components/evidence/SideRail.js";
import type { SideNoteVM, SpanDetailVM } from "../lib/viewmodels/index.js";
import { testSpan1 } from "./fixtures.js";

const testNotes: SideNoteVM[] = [
  { title: "AI ASSESSMENT", text: "High confidence based on clear 429 correlation", accent: "teal" },
  { title: "UNCERTAINTY", text: "Unknown whether Stripe has quota recovery", accent: "amber" },
];

const testDetailCard: SpanDetailVM = {
  spanId: testSpan1.spanId,
  spanName: testSpan1.spanName,
  serviceName: testSpan1.serviceName,
  httpRoute: testSpan1.httpRoute,
  httpMethod: testSpan1.httpMethod,
  httpStatusCode: testSpan1.httpStatusCode,
  spanStatusCode: testSpan1.spanStatusCode,
  spanKind: testSpan1.spanKind,
  durationMs: testSpan1.durationMs,
  startTimeMs: testSpan1.startTimeMs,
  peerService: testSpan1.peerService,
  exceptionCount: testSpan1.exceptionCount,
  parentSpanId: testSpan1.parentSpanId,
  isAiSelected: true,
};

describe("SideRail", () => {
  it("renders note cards", () => {
    render(
      <SideRail notes={testNotes} detailCard={null} activeTab="traces" />,
    );
    expect(screen.getAllByTestId("note-card")).toHaveLength(2);
    expect(screen.getByText("AI ASSESSMENT")).toBeInTheDocument();
    expect(screen.getByText("UNCERTAINTY")).toBeInTheDocument();
  });

  it("renders note card content", () => {
    render(
      <SideRail notes={testNotes} detailCard={null} activeTab="traces" />,
    );
    expect(
      screen.getByText("High confidence based on clear 429 correlation"),
    ).toBeInTheDocument();
  });

  it("renders detail card when provided", () => {
    render(
      <SideRail notes={testNotes} detailCard={testDetailCard} activeTab="traces" />,
    );
    expect(screen.getByTestId("span-detail-card")).toBeInTheDocument();
    expect(screen.getByText("Span Detail")).toBeInTheDocument();
  });

  it("shows AI selected indicator in detail card", () => {
    render(
      <SideRail notes={testNotes} detailCard={testDetailCard} activeTab="traces" />,
    );
    expect(screen.getByText("AI selected for diagnosis")).toBeInTheDocument();
  });

  it("shows span fields in detail card", () => {
    render(
      <SideRail notes={testNotes} detailCard={testDetailCard} activeTab="traces" />,
    );
    expect(screen.getByText("web")).toBeInTheDocument();
    expect(screen.getByText("5200ms")).toBeInTheDocument();
    expect(screen.getByText("429")).toBeInTheDocument();
    expect(screen.getByText("ERROR")).toBeInTheDocument();
  });

  it("renders without detail card", () => {
    render(
      <SideRail notes={testNotes} detailCard={null} activeTab="traces" />,
    );
    expect(screen.queryByTestId("span-detail-card")).toBeNull();
  });

  it("shows exception count when > 0", () => {
    render(
      <SideRail notes={testNotes} detailCard={testDetailCard} activeTab="traces" />,
    );
    // exceptionCount=1 is rendered in a span with color accent-text
    const exceptionFields = document.querySelectorAll(
      '.sd-val[style*="accent-text"]',
    );
    expect(exceptionFields.length).toBeGreaterThan(0);
  });
});
