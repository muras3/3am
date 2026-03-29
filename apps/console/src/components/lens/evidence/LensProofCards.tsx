import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useLensSearch } from "../../../routes/__root.js";
import type { ProofCard } from "../../../api/curated-types.js";

interface Props {
  cards: ProofCard[];
}

function dotVariant(id: string): string {
  if (id === "trigger") return "accent";
  if (id === "design_gap") return "amber";
  if (id === "recovery") return "good";
  return "ink";
}

function statusGlyph(status: string): string {
  if (status === "confirmed") return "\u2713";
  if (status === "pending") return "\u23F3";
  return "~";
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
  const [inlineMessage, setInlineMessage] = useState<string | null>(null);

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

  // Clear inline message when proof changes away from design_gap
  useEffect(() => {
    if (activeProofId !== "design_gap") {
      setInlineMessage(null);
    }
  }, [activeProofId]);

  function handleClick(card: ProofCard) {
    const targetId = selectionTargetId(card);

    // For design_gap with inferred/pending status, show explanation
    if (card.id === "design_gap" && card.status !== "confirmed") {
      setInlineMessage(
        card.summary
        || t("evidence.designGapFallback"),
      );
    } else {
      setInlineMessage(null);
    }

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

  function handleKeyDown(e: React.KeyboardEvent, card: ProofCard) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleClick(card);
    }
  }

  return (
    <div className="lens-ev-proof-nav" role="group" aria-label={t("evidence.proofCardsLabel")}>
      <div className="lens-ev-proof-btns">
        {cards.map((card) => {
          const isActive = activeProofId === card.id;
          const variant = dotVariant(card.id);

          return (
            <button
              key={card.id}
              type="button"
              className={[
                "lens-ev-proof-btn",
                isActive ? "lens-ev-proof-btn-active" : "",
              ].filter(Boolean).join(" ")}
              onClick={() => handleClick(card)}
              onKeyDown={(e) => handleKeyDown(e, card)}
              data-proof-id={card.id}
              aria-pressed={isActive}
            >
              <span
                className={`lens-ev-proof-dot lens-ev-proof-dot-${variant}`}
                aria-hidden="true"
              />
              <span className="lens-ev-proof-label">{card.label}</span>
              <span
                className={`lens-ev-proof-status lens-ev-proof-status-${card.status}`}
                aria-label={t("evidence.statusLabel", { status: card.status })}
              >
                {card.status === "confirmed"
                  ? t("evidence.statusConfirmed")
                  : card.status === "pending"
                    ? t("evidence.statusPending")
                    : t("evidence.statusInferred")}
              </span>
            </button>
          );
        })}
      </div>
      {inlineMessage ? (
        <p className="lens-ev-proof-inline-msg" role="status" aria-live="polite">
          {inlineMessage}
        </p>
      ) : null}
    </div>
  );
}
