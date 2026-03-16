import type { ChangedMetric } from "../../api/types.js";
import {
  buildMetricsSeries,
  buildStatCards,
  extractMetricValue,
} from "../../lib/viewmodels/index.js";
import { EmptyView } from "./EmptyView.js";

interface Props {
  rawMetrics: ChangedMetric[];
  packetMetrics: ChangedMetric[];
  onMetricSelect: (metric: ChangedMetric) => void;
}

interface ChartProps {
  points: Array<{ timeMs: number; value: number }>;
  width?: number;
  height?: number;
}

function MiniChart({ points, width = 240, height = 60 }: ChartProps) {
  if (points.length < 2) {
    return (
      <div
        style={{
          width,
          height,
          border: "1.5px dashed var(--line-strong)",
          borderRadius: "var(--radius-sm)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--panel-2)",
        }}
      >
        <svg width="48" height="32" viewBox="0 0 48 32" fill="none" style={{ opacity: 0.35 }}>
          <polyline
            points="0,28 8,20 16,24 24,10 32,16 40,6 48,12"
            stroke="currentColor"
            strokeWidth="2"
            fill="none"
          />
        </svg>
      </div>
    );
  }

  const padding = 4;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;

  const minVal = Math.min(...points.map((p) => p.value));
  const maxVal = Math.max(...points.map((p) => p.value));
  const valRange = maxVal - minVal || 1;
  const minTime = points[0]!.timeMs;
  const timeRange = (points[points.length - 1]!.timeMs - minTime) || 1;

  const toX = (t: number) => padding + ((t - minTime) / timeRange) * innerW;
  const toY = (v: number) => padding + innerH - ((v - minVal) / valRange) * innerH;

  const linePoints = points.map((p) => `${toX(p.timeMs).toFixed(1)},${toY(p.value).toFixed(1)}`).join(" ");
  const areaPoints = [
    `${toX(points[0]!.timeMs).toFixed(1)},${(padding + innerH).toFixed(1)}`,
    ...points.map((p) => `${toX(p.timeMs).toFixed(1)},${toY(p.value).toFixed(1)}`),
    `${toX(points[points.length - 1]!.timeMs).toFixed(1)},${(padding + innerH).toFixed(1)}`,
  ].join(" ");

  return (
    <svg
      className="chart-container"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
    >
      <polygon points={areaPoints} fill="var(--teal)" opacity="0.08" />
      <polyline points={linePoints} stroke="var(--teal)" strokeWidth="1.5" fill="none" />
      <line
        x1={padding} y1={padding} x2={padding + innerW} y2={padding}
        stroke="var(--line)" strokeWidth="0.5"
      />
      <line
        x1={padding} y1={padding + innerH} x2={padding + innerW} y2={padding + innerH}
        stroke="var(--line)" strokeWidth="0.5"
      />
    </svg>
  );
}

function formatValue(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v % 1 === 0 ? String(v) : v.toFixed(3);
}

export function MetricsView({ rawMetrics, packetMetrics, onMetricSelect }: Props) {
  if (rawMetrics.length === 0) {
    return <EmptyView label="metric" />;
  }

  const series = buildMetricsSeries(rawMetrics);
  const statCards = buildStatCards(rawMetrics, packetMetrics);
  const packetKeys = new Set(packetMetrics.map((m) => `${m.name}::${m.service}`));

  // Use first series for timeseries chart display
  const chartSeries = series[0];

  return (
    <div data-testid="metrics-view">
      {/* Timeseries chart */}
      {chartSeries && (
        <div className="chart-container" style={{ marginBottom: 16 }}>
          <div className="chart-label" style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 4 }}>
            {chartSeries.name} — {chartSeries.service}
          </div>
          <MiniChart points={chartSeries.points} width={480} height={80} />
        </div>
      )}

      {/* Stat strip */}
      <div className="metrics-stat-strip" data-testid="stat-strip">
        {statCards.map((card) => (
          <div
            key={card.key}
            className={`stat-card${card.highlighted ? " highlighted" : ""}`}
            data-testid="stat-card"
          >
            <div className="sc-label">{card.name}</div>
            <div className="sc-value">{formatValue(card.value)}</div>
          </div>
        ))}
      </div>

      {/* Metrics table */}
      <div className="metrics-table" data-testid="metrics-table">
        <div className="mt-header">
          <span>Metric</span>
          <span>Service</span>
          <span>Value</span>
        </div>
        {rawMetrics.map((m, i) => {
          const key = `${m.name}::${m.service}`;
          const highlighted = packetKeys.has(key);
          return (
            <div
              key={i}
              className={`mt-row${highlighted ? " highlighted" : ""}`}
              data-testid="metric-row"
              onClick={() => onMetricSelect(m)}
            >
              <div className="mt-name">{m.name}</div>
              <div className="mt-svc">{m.service}</div>
              <div className="mt-val">{formatValue(extractMetricValue(m.summary))}</div>
            </div>
          );
        })}
      </div>

      {/* Service bar chart */}
      {series.length > 1 && (
        <div className="metrics-bars" data-testid="service-bars">
          {series.slice(0, 8).map((s) => {
            const maxVal = Math.max(...series.slice(0, 8).map((x) => x.points[x.points.length - 1]?.value ?? 0));
            const lastVal = s.points[s.points.length - 1]?.value ?? 0;
            const pct = maxVal > 0 ? (lastVal / maxVal) * 100 : 0;
            return (
              <div key={s.key} className="mb-row">
                <div className="mb-label">{s.name}</div>
                <div className="mb-bar-wrap">
                  <div
                    className="mb-bar"
                    style={{ width: `${pct.toFixed(1)}%` }}
                  />
                </div>
                <div className="mb-val">{formatValue(lastVal)}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
