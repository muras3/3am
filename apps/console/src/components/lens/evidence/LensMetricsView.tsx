import { useEffect } from "react";
import { useSearch } from "@tanstack/react-router";
import type { MetricsSurface, HypothesisGroup } from "../../../api/curated-types.js";
import type { LensSearchParams } from "../../../routes/__root.js";

type ClaimType = HypothesisGroup["type"];

// ── Type icons ────────────────────────────────────────────────
const TYPE_ICON: Record<ClaimType, string> = {
  trigger: "⚡",
  cascade: "⚠",
  recovery: "✓",
  absence: "🔍",
};

// ── Color helpers ─────────────────────────────────────────────
function barColor(type: ClaimType): string {
  switch (type) {
    case "trigger":
      return "var(--accent)";
    case "cascade":
      return "var(--amber)";
    case "recovery":
      return "var(--good)";
    case "absence":
      return "var(--teal)";
    default:
      return "var(--ink-3)";
  }
}

function valueColor(type: ClaimType): string {
  switch (type) {
    case "trigger":
      return "var(--accent-text, var(--accent))";
    case "cascade":
      return "var(--amber)";
    case "recovery":
      return "var(--good)";
    case "absence":
      return "var(--teal)";
    default:
      return "var(--ink-3)";
  }
}

// ── Single hypothesis group ───────────────────────────────────
interface HypGroupBlockProps {
  group: HypothesisGroup;
  activeProofId?: string;
  activeTargetId?: string;
}

function HypGroupBlock({ group, activeProofId, activeTargetId }: HypGroupBlockProps) {
  const isConfirmed = group.verdict === "Confirmed";
  const isHighlighted = activeProofId === group.type || activeTargetId === group.id;

  return (
    <div
      className={`lens-metrics-hyp-group lens-metrics-hyp-type-${group.type}${isHighlighted ? " proof-highlight" : ""}`}
      data-proof={group.type}
      data-target-id={group.id}
    >
      {/* Header */}
      <div className={`lens-metrics-hyp-header lens-metrics-hyp-header-${group.type}`}>
        <span className="lens-metrics-hyp-icon" aria-hidden="true">
          {TYPE_ICON[group.type]}
        </span>
        <span className="lens-metrics-hyp-claim">{group.claim}</span>
        <span
          className={`lens-metrics-hyp-verdict${isConfirmed ? " confirmed" : " inferred"}`}
        >
          {group.verdict}
        </span>
      </div>

      {/* Metric rows */}
      <div className="lens-metrics-hyp-body">
        {group.metrics.map((metric) => (
          <div
            key={metric.name}
            className={`lens-metrics-metric-row${activeTargetId === metric.name ? " proof-highlight" : ""}`}
            data-target-id={metric.name}
          >
            <span className="lens-metrics-metric-name">{metric.name}</span>
            <span
              className="lens-metrics-metric-val"
              style={{ color: valueColor(group.type) }}
            >
              {metric.value}
            </span>
            <div className="lens-metrics-metric-bar">
              <div
                className="lens-metrics-metric-fill"
                style={{
                  width: `${Math.min(100, metric.barPercent)}%`,
                  background: barColor(group.type),
                }}
              />
            </div>
            <span className="lens-metrics-metric-expected">
              expected:&nbsp;{metric.expected}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────
interface LensMetricsViewProps {
  surface: MetricsSurface;
  evidenceDensity?: "rich" | "sparse" | "empty";
  isActive?: boolean;
}

export function LensMetricsView({ surface, evidenceDensity = "rich", isActive = false }: LensMetricsViewProps) {
  const search = useSearch({ from: "__root__" }) as LensSearchParams;
  const activeProofId = search.proof;
  const activeTargetId = search.targetId;

  useEffect(() => {
    if (!isActive) return;
    const selector = activeTargetId
      ? `[data-target-id="${activeTargetId}"]`
      : activeProofId
        ? `[data-proof="${activeProofId}"]`
        : null;
    if (!selector) return;
    document.querySelector(selector)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeProofId, activeTargetId, isActive]);

  if (surface.hypotheses.length === 0) {
    return (
      <div className="lens-metrics-empty">
        {evidenceDensity === "empty"
          ? "Metric lane is reserved. Deterministic comparisons will appear here when incident metrics arrive."
          : "Metric hypotheses are sparse for this incident. The panel stays available for future comparisons."}
      </div>
    );
  }

  return (
    <div className="lens-metrics-root">
      {surface.hypotheses.map((group) => (
        <HypGroupBlock
          key={group.id}
          group={group}
          activeProofId={activeProofId}
          activeTargetId={activeTargetId}
        />
      ))}
    </div>
  );
}
