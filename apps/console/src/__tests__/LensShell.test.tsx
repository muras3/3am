import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { LensShell } from "../components/lens/LensShell.js";

// ── Mock router ───────────────────────────────────────────────

let mockSearch = { level: 0, tab: "traces", incidentId: undefined as string | undefined, proof: undefined, targetId: undefined };
const mockNavigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useSearch: () => mockSearch,
  useNavigate: () => mockNavigate,
}));

// ── Mock sub-components ───────────────────────────────────────

vi.mock("../components/lens/LevelHeader.js", () => ({
  LevelHeader: ({ level, zoomTo }: { level: number; zoomTo: (l: number, el?: HTMLElement) => void }) => (
    <div data-testid={`level-header-${level}`}>
      {level > 0 && (
        <button data-testid={`back-btn-${level}`} onClick={(e) => zoomTo(level - 1, e.currentTarget)}>
          Back
        </button>
      )}
    </div>
  ),
}));

vi.mock("../components/lens/ZoomNav.js", () => ({
  ZoomNav: ({ level, zoomTo }: { level: number; zoomTo: (l: number, el?: HTMLElement) => void }) => (
    <nav data-testid="zoom-nav">
      <button data-testid="crumb-0" onClick={(e) => zoomTo(0, e.currentTarget)}>Map</button>
      <button data-testid="crumb-1" onClick={(e) => zoomTo(1, e.currentTarget)}>Incident</button>
      <button data-testid="crumb-2" onClick={(e) => zoomTo(2, e.currentTarget)}>Evidence</button>
      <span data-testid="current-level">{level}</span>
    </nav>
  ),
}));

beforeEach(() => {
  mockSearch = { level: 0, tab: "traces", incidentId: undefined, proof: undefined, targetId: undefined };
  mockNavigate.mockClear();
});

// ── Tests ─────────────────────────────────────────────────────

describe("LensShell — zoom navigation", () => {
  it("renders three level sections", () => {
    render(<LensShell />);
    const levels = document.querySelectorAll(".level");
    expect(levels).toHaveLength(3);
  });

  it("sets level 0 as active by default", () => {
    render(<LensShell />);
    const levels = document.querySelectorAll(".level");
    expect(levels[0].classList.contains("active")).toBe(true);
    expect(levels[1].classList.contains("active")).toBe(false);
    expect(levels[2].classList.contains("active")).toBe(false);
  });

  it("sets level 1 as active when level=1", () => {
    mockSearch = { level: 1, tab: "traces", incidentId: "inc_test", proof: undefined, targetId: undefined };
    render(<LensShell />);
    const levels = document.querySelectorAll(".level");
    expect(levels[0].classList.contains("zoomed-past")).toBe(true);
    expect(levels[1].classList.contains("active")).toBe(true);
  });

  it("sets level 2 as active when level=2", () => {
    mockSearch = { level: 2, tab: "traces", incidentId: "inc_test", proof: undefined, targetId: undefined };
    render(<LensShell />);
    const levels = document.querySelectorAll(".level");
    expect(levels[0].classList.contains("zoomed-past")).toBe(true);
    expect(levels[1].classList.contains("zoomed-past")).toBe(true);
    expect(levels[2].classList.contains("active")).toBe(true);
  });

  it("marks inactive levels with aria-hidden", () => {
    mockSearch = { level: 1, tab: "traces", incidentId: "inc_test", proof: undefined, targetId: undefined };
    render(<LensShell />);
    const levels = document.querySelectorAll(".level");
    expect(levels[0].getAttribute("aria-hidden")).toBe("true");
    expect(levels[1].getAttribute("aria-hidden")).toBe("false");
    expect(levels[2].getAttribute("aria-hidden")).toBe("true");
  });
});

describe("LensShell — zoom breadcrumb interaction", () => {
  it("navigates to level 1 via breadcrumb", () => {
    mockSearch = { level: 0, tab: "traces", incidentId: "inc_test", proof: undefined, targetId: undefined };
    render(<LensShell />);
    fireEvent.click(screen.getByTestId("crumb-1"));
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({ level: 1 }),
        replace: true,
      }),
    );
  });

  it("strips deeper params when going back to level 0", () => {
    mockSearch = { level: 1, tab: "metrics", incidentId: "inc_test", proof: "trigger", targetId: "span:123" };
    render(<LensShell />);
    fireEvent.click(screen.getByTestId("crumb-0"));
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({
          level: 0,
          incidentId: undefined,
          proof: undefined,
          targetId: undefined,
          tab: "traces",
        }),
      }),
    );
  });
});

describe("LensShell — Escape key", () => {
  it("goes back one level on Escape from level 1", () => {
    mockSearch = { level: 1, tab: "traces", incidentId: "inc_test", proof: undefined, targetId: undefined };
    render(<LensShell />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({ level: 0 }),
      }),
    );
  });

  it("goes back one level on Escape from level 2", () => {
    mockSearch = { level: 2, tab: "traces", incidentId: "inc_test", proof: undefined, targetId: undefined };
    render(<LensShell />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({ level: 1 }),
      }),
    );
  });

  it("does nothing on Escape at level 0", () => {
    mockSearch = { level: 0, tab: "traces", incidentId: undefined, proof: undefined, targetId: undefined };
    render(<LensShell />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe("LensShell — back button interaction", () => {
  it("navigates back via level header back button", () => {
    mockSearch = { level: 1, tab: "traces", incidentId: "inc_test", proof: undefined, targetId: undefined };
    render(<LensShell />);
    fireEvent.click(screen.getByTestId("back-btn-1"));
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({ level: 0 }),
      }),
    );
  });
});
