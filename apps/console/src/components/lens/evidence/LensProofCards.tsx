import { useNavigate, useSearch } from "@tanstack/react-router";
import type { LensSearchParams } from "../../../routes/__root.js";
import type { ProofCard } from "../../../api/curated-types.js";

interface Props {
  cards: ProofCard[];
}

/** Icon character per proof card id pattern */
function iconFor(id: string): string {
  if (id === "trigger") return "⚡";
  if (id === "design") return "⚠";
  if (id === "recovery") return "✓";
  return "●";
}

/** Color variant for icon pill */
function iconVariant(id: string): string {
  if (id === "trigger") return "accent";
  if (id === "design") return "amber";
  if (id === "recovery") return "good";
  return "ink";
}

interface ProofCardItemProps {
  card: ProofCard;
  isActive: boolean;
  onClick: (card: ProofCard) => void;
}

function ProofCardItem({ card, isActive, onClick }: ProofCardItemProps) {
  const variant = iconVariant(card.id);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick(card);
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      className={`lens-ev-proof-card${isActive ? " lens-ev-proof-card-active" : ""}`}
      onClick={() => onClick(card)}
      onKeyDown={handleKeyDown}
      data-proof-id={card.id}
      aria-pressed={isActive}
    >
      <div className="lens-ev-pc-top">
        <div className={`lens-ev-pc-icon lens-ev-pc-icon-${variant}`} aria-hidden="true">
          {iconFor(card.id)}
        </div>
        <span className="lens-ev-pc-label">{card.label}</span>
        <span
          className={`lens-ev-pc-status lens-ev-pc-status-${card.status}`}
          aria-label={`Status: ${card.status}`}
        >
          {card.status === "confirmed" ? "Confirmed" : "Inferred"}
        </span>
      </div>
      <div className="lens-ev-pc-summary">{card.summary}</div>
    </div>
  );
}

/**
 * LensProofCards — 3-column grid of proof cards.
 * Click → updates URL ?proof=<id>&tab=<targetSurface> and triggers highlight effect.
 */
export function LensProofCards({ cards }: Props) {
  const navigate = useNavigate();
  const search = useSearch({ from: "__root__" }) as LensSearchParams;
  const activeProofId = search.proof;

  function handleCardClick(card: ProofCard) {
    void navigate({
      to: "/",
      search: {
        ...search,
        proof: card.id,
        tab: card.targetSurface,
      },
      replace: true,
    });

    // After a short delay, apply highlight class to matching data-proof elements
    setTimeout(() => {
      // Remove existing highlights
      document.querySelectorAll(".proof-highlight").forEach((el) => {
        el.classList.remove("proof-highlight");
      });

      const targets = document.querySelectorAll(`[data-proof="${card.id}"]`);
      targets.forEach((el) => {
        el.classList.add("proof-highlight");
      });

      // Scroll first highlighted element into view
      const first = targets[0];
      if (first) {
        first.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }, 200);
  }

  if (cards.length === 0) return null;

  return (
    <div className="lens-ev-proof-cards" role="group" aria-label="Proof cards">
      {cards.map((card) => (
        <ProofCardItem
          key={card.id}
          card={card}
          isActive={activeProofId === card.id}
          onClick={handleCardClick}
        />
      ))}
    </div>
  );
}
