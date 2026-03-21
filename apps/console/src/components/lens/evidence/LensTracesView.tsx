import { useState, useCallback } from "react";
import type { TraceSurface, TraceGroup, TraceSpan } from "../../../api/curated-types.js";

// ── Type icons for span status ─────────────────────────────────
const STATUS_ICON: Record<string, string> = {
  error: "✕",
  slow: "⚠",
  ok: "✓",
};

// ── Compute proportional bar width relative to root span ──────
function barPercent(durationMs: number, maxDurationMs: number): number {
  if (maxDurationMs === 0) return 100;
  return Math.max(2, Math.round((durationMs / maxDurationMs) * 100));
}

// ── Single span row ───────────────────────────────────────────
interface SpanRowProps {
  span: TraceSpan;
  depth: number;
  maxDurationMs: number;
  isSmokingGun: boolean;
  proofType: string | null;
}

function SpanRow({ span, depth, maxDurationMs, isSmokingGun, proofType }: SpanRowProps) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail =
    (span.attributes && Object.keys(span.attributes).length > 0) ||
    (span.correlatedLogs && span.correlatedLogs.length > 0);
  const widthPct = barPercent(span.durationMs, maxDurationMs);

  const toggle = useCallback(() => {
    if (hasDetail) setExpanded((v) => !v);
  }, [hasDetail]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    },
    [toggle],
  );

  const rowClass = [
    "lens-traces-span-row",
    isSmokingGun ? "smoking-gun" : "",
    hasDetail ? "expandable" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const indent = depth * 14;

  return (
    <>
      <div
        className={rowClass}
        data-proof={proofType ?? undefined}
        data-target-id={span.spanId}
        role={hasDetail ? "button" : undefined}
        tabIndex={hasDetail ? 0 : undefined}
        aria-expanded={hasDetail ? expanded : undefined}
        onClick={toggle}
        onKeyDown={handleKeyDown}
      >
        {/* Name cell — 180px */}
        <span className="lens-traces-span-name" style={{ paddingLeft: indent }}>
          {STATUS_ICON[span.status] && (
            <span className={`lens-traces-status-icon lens-traces-status-icon-${span.status}`}>
              {STATUS_ICON[span.status]}
            </span>
          )}
          {span.name}
        </span>

        {/* Bar track — 1fr */}
        <div className="lens-traces-bar-track">
          <div
            className={`lens-traces-bar lens-traces-bar-${span.status}`}
            style={{ width: `${widthPct}%` }}
          />
        </div>

        {/* Duration — 60px */}
        <span className={`lens-traces-span-dur${isSmokingGun ? " smoking-gun-dur" : ""}`}>
          {span.durationMs.toLocaleString()}ms
        </span>
      </div>

      {/* Expandable detail */}
      {hasDetail && (
        <div
          className={`lens-traces-span-detail${expanded ? " open" : ""}`}
          aria-hidden={!expanded}
        >
          <div className="lens-traces-detail-grid">
            {/* Attributes */}
            {span.attributes && Object.keys(span.attributes).length > 0 && (
              <div className="lens-traces-attrs">
                <div className="lens-traces-detail-label">Attributes</div>
                <dl className="lens-traces-attr-list">
                  {Object.entries(span.attributes).map(([k, v]) => (
                    <div key={k} className="lens-traces-attr-row">
                      <dt className="lens-traces-attr-key">{k}</dt>
                      <dd className="lens-traces-attr-val">{String(v)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}

            {/* Correlated logs */}
            {span.correlatedLogs && span.correlatedLogs.length > 0 && (
              <div className="lens-traces-corr-logs">
                <div className="lens-traces-detail-label">Correlated Logs</div>
                {span.correlatedLogs.map((log, i) => (
                  <div key={i} className="lens-traces-corr-log-row">
                    <span className="lens-traces-corr-log-ts">{log.timestamp}</span>
                    <span
                      className={`lens-traces-corr-log-sev lens-traces-log-sev-${log.severity.toLowerCase()}`}
                    >
                      {log.severity}
                    </span>
                    <span className="lens-traces-corr-log-body">{log.body}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ── DFS span tree rendering ───────────────────────────────────
function buildSpanTree(
  spans: TraceSpan[],
  smokingGunSpanId: string | null,
  proofType: string | null,
) {
  const maxDuration = spans.reduce((m, s) => Math.max(m, s.durationMs), 0);

  // Build parent→children map
  const childMap = new Map<string | undefined, TraceSpan[]>();
  for (const span of spans) {
    const parent = span.parentSpanId;
    if (!childMap.has(parent)) childMap.set(parent, []);
    childMap.get(parent)!.push(span);
  }

  const rows: React.ReactElement[] = [];

  function walk(parentId: string | undefined, depth: number) {
    const children = childMap.get(parentId) ?? [];
    for (const span of children) {
      rows.push(
        <SpanRow
          key={span.spanId}
          span={span}
          depth={depth}
          maxDurationMs={maxDuration}
          isSmokingGun={span.spanId === smokingGunSpanId}
          proofType={proofType}
        />,
      );
      walk(span.spanId, depth + 1);
    }
  }

  walk(undefined, 0);
  return rows;
}

// ── Trace group ───────────────────────────────────────────────
interface TraceGroupBlockProps {
  group: TraceGroup;
  smokingGunSpanId: string | null;
  isExpected?: boolean;
  proofType: string | null;
}

function TraceGroupBlock({
  group,
  smokingGunSpanId,
  isExpected = false,
  proofType,
}: TraceGroupBlockProps) {
  const isError = group.status >= 500;
  const headerClass = [
    "lens-traces-trace-header",
    isError && !isExpected ? "error-header" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className="lens-traces-trace-group"
      data-proof={proofType ?? undefined}
      data-target-id={group.traceId}
    >
      <div className={headerClass}>
        <span
          className={`lens-traces-health-dot lens-traces-health-dot-${isError ? "error" : "ok"}`}
        />
        <span className="lens-traces-trace-route">{group.route}</span>
        <span className="lens-traces-trace-id">tid:{group.traceId.slice(0, 8)}</span>
        <span className={`lens-traces-trace-status lens-traces-trace-status-${isError ? "error" : "ok"}`}>
          {group.status}
        </span>
        <span
          className={`lens-traces-trace-dur${isError && !isExpected ? " anomalous" : ""}`}
        >
          {group.durationMs.toLocaleString()}ms
          {group.expectedDurationMs && !isExpected && (
            <span className="lens-traces-dur-expected">
              {" "}expected: {group.expectedDurationMs}ms
            </span>
          )}
        </span>
        {isExpected && (
          <span className="lens-traces-expected-badge">expected behavior</span>
        )}
      </div>

      {/* Annotation */}
      {group.annotation && (
        <div className={`lens-traces-annotation${isExpected ? " teal" : ""}`}>
          {group.annotation}
        </div>
      )}

      {/* Span rows */}
      {buildSpanTree(group.spans, smokingGunSpanId, proofType)}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────
interface LensTracesViewProps {
  surface: TraceSurface;
}

export function LensTracesView({ surface }: LensTracesViewProps) {
  const [baselineVisible, setBaselineVisible] = useState(false);

  const toggleBaseline = useCallback(() => setBaselineVisible((v) => !v), []);
  const handleBaselineKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleBaseline();
      }
    },
    [toggleBaseline],
  );

  const { observed, expected, smokingGunSpanId } = surface;

  return (
    <div className="lens-traces-root">
      {/* Observed traces */}
      {observed.length === 0 ? (
        <div className="lens-traces-empty">No observed traces for this incident.</div>
      ) : (
        observed.map((group) => (
          <TraceGroupBlock
            key={group.traceId}
            group={group}
            smokingGunSpanId={smokingGunSpanId}
            proofType="trigger"
          />
        ))
      )}

      {/* Baseline toggle */}
      {expected.length > 0 && (
        <>
          <div
            className="lens-traces-baseline-toggle"
            role="button"
            tabIndex={0}
            aria-expanded={baselineVisible}
            onClick={toggleBaseline}
            onKeyDown={handleBaselineKeyDown}
          >
            {baselineVisible ? "Hide expected trace" : "Show expected trace"}
          </div>

          <div className={`lens-traces-baseline-group${baselineVisible ? "" : " muted"}`}>
            {expected.map((group) => (
              <TraceGroupBlock
                key={group.traceId}
                group={group}
                smokingGunSpanId={null}
                isExpected
                proofType="recovery"
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
