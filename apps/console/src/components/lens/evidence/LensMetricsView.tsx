import type { MetricsSurface, HypothesisGroup, ClaimType } from "../../../api/curated-types.js";

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
  }
}

// ── Single hypothesis group ───────────────────────────────────
interface HypGroupBlockProps {
  group: HypothesisGroup;
}

function HypGroupBlock({ group }: HypGroupBlockProps) {
  const isConfirmed = group.verdict === "Confirmed";

  return (
    <div
      className={`lens-metrics-hyp-group lens-metrics-hyp-type-${group.type}`}
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
          <div key={metric.name} className="lens-metrics-metric-row">
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
}

export function LensMetricsView({ surface }: LensMetricsViewProps) {
  if (surface.hypotheses.length === 0) {
    return <div className="lens-metrics-empty">No metric hypotheses for this incident.</div>;
  }

  return (
    <div className="lens-metrics-root">
      {surface.hypotheses.map((group) => (
        <HypGroupBlock key={group.id} group={group} />
      ))}
    </div>
  );
}
