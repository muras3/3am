import { useEffect, useState, useCallback } from "react";
import { useSearch } from "@tanstack/react-router";
import type { TraceSurface, TraceGroup, TraceSpan } from "../../../api/curated-types.js";
import type { LensSearchParams } from "../../../routes/__root.js";

const STATUS_ICON: Record<string, string> = {
  error: "!",
  slow: "~",
  ok: "+",
};

function barPercent(durationMs: number, maxDurationMs: number): number {
  if (maxDurationMs === 0) return 100;
  return Math.max(2, Math.round((durationMs / maxDurationMs) * 100));
}

interface SpanRowProps {
  span: TraceSpan;
  depth: number;
  maxDurationMs: number;
  isSmokingGun: boolean;
  proofType: string | null;
  selectedTargetId?: string;
}

function SpanRow({
  span,
  depth,
  maxDurationMs,
  isSmokingGun,
  proofType,
  selectedTargetId,
}: SpanRowProps) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail =
    (span.attributes && Object.keys(span.attributes).length > 0)
    || (span.correlatedLogs && span.correlatedLogs.length > 0);
  const widthPct = barPercent(span.durationMs, maxDurationMs);

  const toggle = useCallback(() => {
    if (hasDetail) setExpanded((v) => !v);
  }, [hasDetail]);

  useEffect(() => {
    if (hasDetail && selectedTargetId === span.spanId) {
      setExpanded(true);
    }
  }, [hasDetail, selectedTargetId, span.spanId]);

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
  ].filter(Boolean).join(" ");

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
        <span className="lens-traces-span-name" style={{ paddingLeft: indent }}>
          {STATUS_ICON[span.status] && (
            <span className={`lens-traces-status-icon lens-traces-status-icon-${span.status}`}>
              {STATUS_ICON[span.status]}
            </span>
          )}
          {span.name}
        </span>

        <div className="lens-traces-bar-track">
          <div
            className={`lens-traces-bar lens-traces-bar-${span.status}`}
            style={{ width: `${widthPct}%` }}
          />
        </div>

        <span className={`lens-traces-span-dur${isSmokingGun ? " smoking-gun-dur" : ""}`}>
          {span.durationMs.toLocaleString()}ms
        </span>
      </div>

      {hasDetail && (
        <div
          className={`lens-traces-span-detail${expanded ? " open" : ""}`}
          aria-hidden={!expanded}
        >
          <div className="lens-traces-detail-grid">
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

            {span.correlatedLogs && span.correlatedLogs.length > 0 && (
              <div className="lens-traces-corr-logs">
                <div className="lens-traces-detail-label">Correlated Logs</div>
                {span.correlatedLogs.map((log, i) => (
                  <div key={`${log.timestamp}-${i}`} className="lens-traces-corr-log-row">
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

function buildSpanTree(
  spans: TraceSpan[],
  smokingGunSpanId: string | null,
  proofType: string | null,
  selectedTargetId?: string,
) {
  const maxDuration = spans.reduce((m, s) => Math.max(m, s.durationMs), 0);
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
          selectedTargetId={selectedTargetId}
        />,
      );
      walk(span.spanId, depth + 1);
    }
  }

  walk(undefined, 0);
  return rows;
}

interface TraceGroupBlockProps {
  group: TraceGroup;
  smokingGunSpanId: string | null;
  isExpected?: boolean;
  proofType: string | null;
  selectedTargetId?: string;
}

function TraceGroupBlock({
  group,
  smokingGunSpanId,
  isExpected = false,
  proofType,
  selectedTargetId,
}: TraceGroupBlockProps) {
  const isError = group.status >= 500;
  const headerClass = [
    "lens-traces-trace-header",
    isError && !isExpected ? "error-header" : "",
  ].filter(Boolean).join(" ");

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
        <span className={`lens-traces-trace-dur${isError && !isExpected ? " anomalous" : ""}`}>
          {group.durationMs.toLocaleString()}ms
          {group.expectedDurationMs && !isExpected && (
            <span className="lens-traces-dur-expected"> expected: {group.expectedDurationMs}ms</span>
          )}
        </span>
        {isExpected && (
          <span className="lens-traces-expected-badge">expected behavior</span>
        )}
      </div>

      {group.annotation && (
        <div className={`lens-traces-annotation${isExpected ? " teal" : ""}`}>
          {group.annotation}
        </div>
      )}

      {buildSpanTree(group.spans, smokingGunSpanId, proofType, selectedTargetId)}
    </div>
  );
}

interface LensTracesViewProps {
  surface: TraceSurface;
  baselineState?: "ready" | "insufficient" | "unavailable";
  evidenceDensity?: "rich" | "sparse" | "empty";
}

export function LensTracesView({
  surface,
  baselineState = "ready",
  evidenceDensity = "rich",
}: LensTracesViewProps) {
  const [baselineVisible, setBaselineVisible] = useState(false);
  const search = useSearch({ from: "__root__" }) as LensSearchParams;
  const selectedTargetId = search.targetId;

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
  const baselineUnavailable = expected.length === 0;
  const baselineToggleLabel = baselineUnavailable
    ? baselineState === "unavailable"
      ? "Expected trace unavailable"
      : "Expected trace is sparse"
    : baselineVisible
      ? "Hide expected trace"
      : "Show expected trace";

  return (
    <div className="lens-traces-root">
      {observed.length === 0 ? (
        <div className="lens-traces-empty">
          {evidenceDensity === "empty"
            ? "Observed trace lane is reserved. Deterministic trace evidence will appear here when telemetry arrives."
            : "Only limited traces are available for this incident."}
        </div>
      ) : (
        observed.map((group) => (
          <TraceGroupBlock
            key={group.traceId}
            group={group}
            smokingGunSpanId={smokingGunSpanId}
            proofType="trigger"
            selectedTargetId={selectedTargetId}
          />
        ))
      )}

      <div
        className={`lens-traces-baseline-toggle${baselineUnavailable ? " disabled" : ""}`}
        role="button"
        tabIndex={baselineUnavailable ? -1 : 0}
        aria-expanded={baselineVisible}
        aria-disabled={baselineUnavailable}
        onClick={baselineUnavailable ? undefined : toggleBaseline}
        onKeyDown={baselineUnavailable ? undefined : handleBaselineKeyDown}
      >
        {baselineToggleLabel}
      </div>

      <div className={`lens-traces-baseline-group${baselineVisible && !baselineUnavailable ? "" : " muted"}`}>
        {expected.length > 0 ? (
          expected.map((group) => (
            <TraceGroupBlock
              key={group.traceId}
              group={group}
              smokingGunSpanId={null}
              isExpected
              proofType="recovery"
              selectedTargetId={selectedTargetId}
            />
          ))
        ) : (
          <div className="lens-traces-empty lens-traces-empty-baseline">
            {baselineState === "unavailable"
              ? "No baseline trace was available for this incident window."
              : "Baseline comparison is currently too sparse to render expected behavior."}
          </div>
        )}
      </div>
    </div>
  );
}
