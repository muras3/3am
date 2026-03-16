import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { ProofCards } from "../components/evidence/ProofCards.js";
import { buildProofCardsV4 } from "../lib/viewmodels/index.js";
import { testIncident, testIncidentNoDiagnosis } from "./fixtures.js";

describe("ProofCards", () => {
  it("renders 3 proof cards", () => {
    const cards = buildProofCardsV4(testIncident);
    render(
      <ProofCards cards={cards} viewingId={null} onCardClick={vi.fn()} />,
    );
    expect(screen.getAllByTestId("proof-card")).toHaveLength(3);
  });

  it("renders card labels", () => {
    const cards = buildProofCardsV4(testIncident);
    render(
      <ProofCards cards={cards} viewingId={null} onCardClick={vi.fn()} />,
    );
    expect(screen.getByText("External Trigger")).toBeInTheDocument();
    expect(screen.getByText("Design Gap")).toBeInTheDocument();
    expect(screen.getByText("Recovery Signal")).toBeInTheDocument();
  });

  it("applies .viewing class to active card", () => {
    const cards = buildProofCardsV4(testIncident);
    render(
      <ProofCards cards={cards} viewingId="trigger" onCardClick={vi.fn()} />,
    );
    const viewingCards = document.querySelectorAll(".proof-card.viewing");
    expect(viewingCards).toHaveLength(1);
  });

  it("does not apply .viewing when viewingId is null", () => {
    const cards = buildProofCardsV4(testIncident);
    render(
      <ProofCards cards={cards} viewingId={null} onCardClick={vi.fn()} />,
    );
    const viewingCards = document.querySelectorAll(".proof-card.viewing");
    expect(viewingCards).toHaveLength(0);
  });

  it("calls onCardClick when card is clicked", async () => {
    const user = userEvent.setup();
    const cards = buildProofCardsV4(testIncident);
    const onCardClick = vi.fn();
    render(
      <ProofCards cards={cards} viewingId={null} onCardClick={onCardClick} />,
    );
    await user.click(screen.getByText("External Trigger"));
    expect(onCardClick).toHaveBeenCalledOnce();
    expect(onCardClick).toHaveBeenCalledWith(cards[0]);
  });

  it("renders cards without diagnosis result (graceful degrade)", () => {
    const cards = buildProofCardsV4(testIncidentNoDiagnosis);
    render(
      <ProofCards cards={cards} viewingId={null} onCardClick={vi.fn()} />,
    );
    expect(screen.getAllByTestId("proof-card")).toHaveLength(3);
  });

  it("renders status badges", () => {
    const cards = buildProofCardsV4(testIncident);
    render(
      <ProofCards cards={cards} viewingId={null} onCardClick={vi.fn()} />,
    );
    // At least one confirmed status expected (from diagnosis result)
    const confirmedBadges = document.querySelectorAll(".pc-status-confirmed");
    expect(confirmedBadges.length).toBeGreaterThan(0);
  });
});
