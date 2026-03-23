import { useNavigate, useSearch } from "@tanstack/react-router";
import type { LensSearchParams } from "../../../routes/__root.js";
import type { ProofCard } from "../../../api/curated-types.js";

interface Props {
  cards: ProofCard[];
  diagnosisState?: "ready" | "pending" | "unavailable";
}

function iconFor(id: string): string {
  if (id === "trigger") return "T";
  if (id === "design_gap") return "D";
  if (id === "recovery") return "R";
  return "•";
}

function iconVariant(id: string): string {
  if (id === "trigger") return "accent";
  if (id === "design_gap") return "amber";
  if (id === "recovery") return "good";
  return "ink";
}

interface ProofCardItemProps {
  card: ProofCard;
  isActive: boolean;
  isPlaceholder?: boolean;
  onClick: (card: ProofCard) => void;
}

function ProofCardItem({ card, isActive, isPlaceholder = false, onClick }: ProofCardItemProps) {
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
      tabIndex={isPlaceholder ? -1 : 0}
      className={[
        "lens-ev-proof-card",
        isActive ? "lens-ev-proof-card-active" : "",
        isPlaceholder ? "lens-ev-proof-card-placeholder" : "",
      ].filter(Boolean).join(" ")}
      onClick={isPlaceholder ? undefined : () => onClick(card)}
      onKeyDown={isPlaceholder ? undefined : handleKeyDown}
      data-proof-id={card.id}
      aria-pressed={isActive}
      aria-disabled={isPlaceholder}
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
          {card.status === "confirmed"
            ? "Confirmed"
            : card.status === "pending"
              ? "Pending"
              : "Inferred"}
        </span>
      </div>
      <div className="lens-ev-pc-summary">{card.summary || "Awaiting deterministic evidence."}</div>
    </div>
  );
}

const PLACEHOLDER_CARDS: ProofCard[] = [
  {
    id: "trigger",
    label: "External Trigger",
    status: "pending",
    summary: "",
    targetSurface: "traces",
    evidenceRefs: [],
  },
  {
    id: "design_gap",
    label: "Design Gap",
    status: "pending",
    summary: "",
    targetSurface: "metrics",
    evidenceRefs: [],
  },
  {
    id: "recovery",
    label: "Recovery Signal",
    status: "pending",
    summary: "",
    targetSurface: "traces",
    evidenceRefs: [],
  },
];

function buildPlaceholderCards(
  cards: ProofCard[],
  diagnosisState: Props["diagnosisState"],
): ProofCard[] {
  if (cards.length > 0) return cards;

  return PLACEHOLDER_CARDS.map((card) => ({
    ...card,
    summary: diagnosisState === "unavailable"
      ? "No diagnosis narrative yet. This slot stays reserved for deterministic evidence."
      : "Evidence is still being assembled for this proof lane.",
  }));
}

function selectionTargetId(card: ProofCard): string | undefined {
  const firstRef = card.evidenceRefs[0];
  if (!firstRef) return undefined;

  if (firstRef.kind === "span") {
    const [, spanId] = firstRef.id.split(":");
    return spanId ?? firstRef.id;
  }

  if (
    firstRef.kind === "metric"
    || firstRef.kind === "metric_group"
    || firstRef.kind === "log_cluster"
  ) {
    return firstRef.id;
  }

  return undefined;
}

function applySelectionHighlight(proofId?: string, targetId?: string) {
  document.querySelectorAll(".proof-highlight").forEach((el) => {
    el.classList.remove("proof-highlight");
  });

  const selectors = [
    targetId ? `[data-target-id="${targetId}"]` : null,
    proofId ? `[data-proof="${proofId}"]` : null,
  ].filter(Boolean) as string[];

  for (const selector of selectors) {
    const targets = document.querySelectorAll(selector);
    if (targets.length === 0) continue;
    targets.forEach((el) => el.classList.add("proof-highlight"));
    targets[0]?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
}

export function LensProofCards({ cards, diagnosisState }: Props) {
  const navigate = useNavigate();
  const search = useSearch({ from: "__root__" }) as LensSearchParams;
  const activeProofId = search.proof;
  const renderedCards = buildPlaceholderCards(cards, diagnosisState);
  const showingPlaceholders = cards.length === 0;

  function handleCardClick(card: ProofCard) {
    const targetId = selectionTargetId(card);

    void navigate({
      to: "/",
      search: {
        ...search,
        proof: card.id,
        tab: card.targetSurface,
        targetId,
      },
      replace: true,
    });

    setTimeout(() => {
      applySelectionHighlight(card.id, targetId);
    }, 200);
  }

  return (
    <div className="lens-ev-proof-cards" role="group" aria-label="Proof cards">
      {renderedCards.map((card) => (
        <ProofCardItem
          key={card.id}
          card={card}
          isActive={activeProofId === card.id}
          isPlaceholder={showingPlaceholders}
          onClick={handleCardClick}
        />
      ))}
    </div>
  );
}
