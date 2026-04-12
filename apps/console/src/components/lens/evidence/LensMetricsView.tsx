import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetricsSurface, HypothesisGroup } from "../../../api/curated-types.js";
import { useLensSearch } from "../../../routes/__root.js";

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
  const { t } = useTranslation();
  const isConfirmed = group.verdict === "Confirmed";
  const isHighlighted = activeProofId === group.type || activeTargetId === group.id;
  const [expanded, setExpanded] = useState(group.metrics.length <= 5 || activeTargetId != null);
  const canCollapse = group.metrics.length > 5;
  const visibleMetrics = expanded ? group.metrics : group.metrics.slice(0, 5);
  const toggle = useCallback(() => {
    if (!canCollapse) return;
    setExpanded((value) => !value);
  }, [canCollapse]);

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
        {visibleMetrics.map((metric) => (
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
              {t("evidence.metrics.expected", { value: metric.expected })}
            </span>
          </div>
        ))}
        {canCollapse && (
          <button
            className="lens-metrics-group-toggle"
            type="button"
            onClick={toggle}
          >
            {expanded
              ? t("evidence.metrics.collapseGroup")
              : t("evidence.metrics.expandGroup", { count: group.metrics.length - visibleMetrics.length })}
          </button>
        )}
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
  const { t } = useTranslation();
  const search = useLensSearch();
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
          ? t("evidence.metrics.emptyReserved")
          : t("evidence.metrics.thinSignal")}
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
