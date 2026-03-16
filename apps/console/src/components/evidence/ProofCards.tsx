import type { ProofCardV4VM } from "../../lib/viewmodels/index.js";

interface Props {
  cards: ProofCardV4VM[];
  viewingId: string | null;
  onCardClick: (card: ProofCardV4VM) => void;
}

function statusLabel(status: ProofCardV4VM["status"]): string {
  if (status === "confirmed") return "confirmed";
  if (status === "inferred") return "inferred";
  return "pending";
}

function statusClass(status: ProofCardV4VM["status"]): string {
  if (status === "confirmed") return "pc-status-confirmed";
  if (status === "inferred") return "pc-status-inferred";
  return "pc-status-pending";
}

export function ProofCards({ cards, viewingId, onCardClick }: Props) {
  return (
    <div className="es-proof-cards" data-testid="proof-cards">
      {cards.map((card) => (
        <button
          key={card.id}
          className={`proof-card${viewingId === card.id ? " viewing" : ""}`}
          data-testid="proof-card"
          onClick={() => onCardClick(card)}
        >
          <div className={`pc-icon pc-icon-${card.iconClass}`}>{card.icon}</div>
          <div className="pc-label">{card.label}</div>
          <div className="pc-summary">{card.summary}</div>
          {card.evidence && (
            <div className="pc-evidence">{card.evidence}</div>
          )}
          <div className={`pc-status ${statusClass(card.status)}`}>
            {statusLabel(card.status)}
          </div>
        </button>
      ))}
    </div>
  );
}
