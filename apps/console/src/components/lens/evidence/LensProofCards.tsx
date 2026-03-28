import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useLensSearch } from "../../../routes/__root.js";
import type { ProofCard } from "../../../api/curated-types.js";

interface Props {
  cards: ProofCard[];
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
  onClick: (card: ProofCard) => void;
}

function ProofCardItem({ card, isActive, onClick }: ProofCardItemProps) {
  const { t } = useTranslation();
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
      className={[
        "lens-ev-proof-card",
        isActive ? "lens-ev-proof-card-active" : "",
      ].filter(Boolean).join(" ")}
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
          aria-label={t("evidence.statusLabel", { status: card.status })}
        >
          {card.status === "confirmed"
            ? t("evidence.statusConfirmed")
            : card.status === "pending"
              ? t("evidence.statusPending")
              : t("evidence.statusInferred")}
        </span>
      </div>
      <div className="lens-ev-pc-summary">{card.summary}</div>
    </div>
  );
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

export function LensProofCards({ cards }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useLensSearch();
  const activeProofId = search.proof;
  const activeTargetId = search.targetId;

  useEffect(() => {
    if (!activeProofId && !activeTargetId) return;

    const selectors = [
      activeTargetId ? `[data-target-id="${activeTargetId}"]` : null,
      activeProofId ? `[data-proof="${activeProofId}"]` : null,
    ].filter(Boolean) as string[];

    for (const selector of selectors) {
      const target = document.querySelector(selector);
      if (!target) continue;
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
  }, [activeProofId, activeTargetId, search.tab]);

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
  }

  return (
    <div className="lens-ev-proof-cards" role="group" aria-label={t("evidence.proofCardsLabel")}>
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
