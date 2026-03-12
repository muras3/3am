import type { ProofCardVM } from "../../lib/viewmodels/index.js";

interface Props {
  cards: ProofCardVM[];
}

export function ProofCards({ cards }: Props) {
  return (
    <div className="proof-cards" data-testid="proof-cards">
      {cards.map((card, i) => (
        <div key={i} className="proof-card" data-testid="proof-card">
          <div className="proof-card-label">{card.label}</div>
          <div className="proof-card-proof">{card.proof}</div>
          {card.detail && (
            <div className="proof-card-detail">{card.detail}</div>
          )}
          <div className="proof-card-source">{card.sourceFamily}</div>
        </div>
      ))}
    </div>
  );
}
