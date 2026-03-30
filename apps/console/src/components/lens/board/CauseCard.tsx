import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CausalStep, CuratedState } from "../../../api/curated-types.js";
import { sectionFallback } from "./board-state.js";

/* ── Detail tooltip (CSS-only, appears on hover/focus) ──── */

function StepDetail({ text }: { text: string }) {
  const detailRef = useRef<HTMLDivElement | null>(null);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    const el = detailRef.current;
    if (!el) return;
    setTruncated(el.scrollHeight > el.clientHeight);
  }, [text]);

  return (
    <div className="lens-board-step-detail-wrap">
      <div className="lens-board-step-detail" ref={detailRef}>{text}</div>
      {truncated && (
        <div className="lens-board-step-tooltip" role="tooltip">{text}</div>
      )}
    </div>
  );
}

interface Props {
  steps: CausalStep[];
  state: CuratedState;
}

function stepTypeClass(type: CausalStep["type"]): string {
  switch (type) {
    case "external": return "lens-board-chain-step-external";
    case "system":   return "lens-board-chain-step-system";
    case "incident": return "lens-board-chain-step-incident";
    case "impact":   return "lens-board-chain-step-impact";
    default:         return "lens-board-chain-step-incident";
  }
}

/* ── Serpentine row splitting ──────────────────────────────── */

const STEP_MIN_W = 140;
const ARROW_W = 28;

function useSerpentineRows(
  steps: CausalStep[],
): { rows: CausalStep[][]; containerRef: React.RefObject<HTMLDivElement | null> } {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [perRow, setPerRow] = useState(steps.length);

  const measure = useCallback(() => {
    const el = containerRef.current;
    if (!el || steps.length === 0) return;
    const w = el.clientWidth;
    // Solve: n * STEP_MIN_W + (n - 1) * ARROW_W <= w
    // n <= (w + ARROW_W) / (STEP_MIN_W + ARROW_W)
    const n = Math.max(1, Math.floor((w + ARROW_W) / (STEP_MIN_W + ARROW_W)));
    setPerRow(prev => (prev === n ? prev : n));
  }, [steps.length]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [measure]);

  const rows = useMemo(() => {
    const result: CausalStep[][] = [];
    for (let i = 0; i < steps.length; i += perRow) {
      result.push(steps.slice(i, i + perRow));
    }
    return result;
  }, [steps, perRow]);

  return { rows, containerRef };
}

/* ── Sub-components ────────────────────────────────────────── */

function ChainArrow() {
  return (
    <div className="lens-board-chain-arrow" aria-hidden="true">
      <svg width="28" height="20" viewBox="0 0 28 20">
        <line x1="0" y1="10" x2="20" y2="10" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 6" />
        <polygon points="20,6 28,10 20,14" fill="currentColor" />
      </svg>
    </div>
  );
}

function TurnConnector({ direction }: { direction: "right-to-left" | "left-to-right" }) {
  // right-to-left: drop on right side, flow leftward (row 0→1)
  // left-to-right: drop on left side, flow rightward (row 1→2)
  const rtl = direction === "right-to-left";
  return (
    <div
      className="lens-board-chain-turn"
      aria-hidden="true"
      style={{ justifyContent: rtl ? "flex-end" : "flex-start" }}
    >
      <svg
        width="40" height="24" viewBox="0 0 40 24"
        style={{ transform: rtl ? "none" : "scaleX(-1)" }}
      >
        <path
          d="M 20 0 L 20 12 L 4 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="4 6"
        />
        <polygon points="4,8 0,12 4,16" fill="currentColor" />
      </svg>
    </div>
  );
}

/* ── Main component ────────────────────────────────────────── */

export function CauseCard({ steps, state }: Props) {
  const { t } = useTranslation();
  const { rows, containerRef } = useSerpentineRows(steps);

  return (
    <div className="lens-board-chain-section">
      <h2 className="lens-board-section-label">{t("board.causalChain.title")}</h2>
      <div className="lens-board-chain-flow" ref={containerRef} role="list">
        {steps.length > 0 ? rows.map((rowSteps, rowIdx) => {
          const reversed = rowIdx % 2 === 1;
          return (
            <Fragment key={rowIdx}>
              {rowIdx > 0 && (
                <TurnConnector
                  direction={reversed ? "right-to-left" : "left-to-right"}
                />
              )}
              <div
                className={`lens-board-chain-row${reversed ? " lens-board-chain-row-reversed" : ""}`}
                role="presentation"
              >
                {rowSteps.map((step, i) => (
                  <Fragment key={`${step.type}-${i}`}>
                    <div
                      className={`lens-board-chain-step ${stepTypeClass(step.type)}`}
                      data-type={step.type}
                      role="listitem"
                      tabIndex={0}
                      aria-label={`${step.tag}: ${step.title}. ${step.detail}`}
                    >
                      <div className="lens-board-step-tag">{step.tag}</div>
                      <div className="lens-board-step-title">{step.title}</div>
                      <StepDetail text={step.detail} />
                    </div>
                    {i < rowSteps.length - 1 && <ChainArrow />}
                  </Fragment>
                ))}
              </div>
            </Fragment>
          );
        }) : (
          <div className="lens-board-chain-placeholder" role="listitem">
            {sectionFallback(state, "chain")}
          </div>
        )}
      </div>
    </div>
  );
}
