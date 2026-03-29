import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { TraceSurface, TraceGroup, TraceSpan } from "../../../api/curated-types.js";
import { useLensSearch } from "../../../routes/__root.js";

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
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const hasDetail =
    (span.attributes && Object.keys(span.attributes).length > 0)
    || (span.correlatedLogs && span.correlatedLogs.length > 0);
  const widthPct = barPercent(span.durationMs, maxDurationMs);

  const toggle = useCallback(() => {
    if (hasDetail) setExpanded((v) => !v);
  }, [hasDetail]);

  useEffect(() => {
    if (hasDetail && (selectedTargetId === span.spanId || (isSmokingGun && !selectedTargetId))) {
      setExpanded(true);
    }
  }, [hasDetail, selectedTargetId, span.spanId, isSmokingGun]);

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
                <div className="lens-traces-detail-label">{t("evidence.traces.attributes")}</div>
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
                <div className="lens-traces-detail-label">{t("evidence.traces.correlatedLogs")}</div>
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

interface TraceGroupCluster {
  key: string;
  route: string;
  status: number;
  count: number;
  avgDurationMs: number;
  maxDurationMs: number;
  groups: TraceGroup[];
}

function buildTraceClusters(groups: TraceGroup[]): TraceGroupCluster[] {
  const clusters = new Map<string, TraceGroupCluster>();

  for (const group of groups) {
    const key = `${group.route}::${group.status}`;
    const current = clusters.get(key);
    if (current) {
      current.groups.push(group);
      current.count += 1;
      current.avgDurationMs += group.durationMs;
      current.maxDurationMs = Math.max(current.maxDurationMs, group.durationMs);
      continue;
    }
    clusters.set(key, {
      key,
      route: group.route,
      status: group.status,
      count: 1,
      avgDurationMs: group.durationMs,
      maxDurationMs: group.durationMs,
      groups: [group],
    });
  }

  return [...clusters.values()].map((cluster) => ({
    ...cluster,
    avgDurationMs: Math.round(cluster.avgDurationMs / cluster.count),
  }));
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
  const { t } = useTranslation();
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
            <span className="lens-traces-dur-expected"> {t("evidence.traces.expected", { duration: group.expectedDurationMs })}</span>
          )}
        </span>
        {isExpected && (
          <span className="lens-traces-expected-badge">{t("evidence.traces.expectedBehavior")}</span>
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

function TraceClusterBlock({
  cluster,
  smokingGunSpanId,
  isExpected = false,
  proofType,
  selectedTargetId,
}: {
  cluster: TraceGroupCluster;
  smokingGunSpanId: string | null;
  isExpected?: boolean;
  proofType: string | null;
  selectedTargetId?: string;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(() => {
    if (cluster.count <= 1) return true;
    if (!selectedTargetId) return false;
    return cluster.groups.some((group) =>
      group.traceId === selectedTargetId
      || group.spans.some((span) => span.spanId === selectedTargetId),
    );
  });
  const containsHighlight = selectedTargetId
    ? cluster.groups.some((group) =>
        group.traceId === selectedTargetId
        || group.spans.some((span) => span.spanId === selectedTargetId),
      )
    : false;
  const isHighlighted = containsHighlight && cluster.count > 1;
  const isError = cluster.status >= 500;
  const canCollapse = cluster.count > 1;

  useEffect(() => {
    if (!selectedTargetId || cluster.count <= 1) return;
    if (containsHighlight) setExpanded(true);
  }, [containsHighlight, cluster.count, selectedTargetId]);

  const handleToggle = useCallback(() => {
    if (!canCollapse) return;
    setExpanded((value) => !value);
  }, [canCollapse]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!canCollapse) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleToggle();
    }
  }, [canCollapse, handleToggle]);

  if (!canCollapse) {
    return (
      <TraceGroupBlock
        group={cluster.groups[0]!}
        smokingGunSpanId={smokingGunSpanId}
        isExpected={isExpected}
        proofType={proofType}
        selectedTargetId={selectedTargetId}
      />
    );
  }

  return (
    <div
      className={`lens-traces-cluster${isHighlighted ? " proof-highlight" : ""}${expanded ? " open" : ""}`}
      data-proof={proofType ?? undefined}
      data-target-id={cluster.key}
    >
      <div
        className={`lens-traces-cluster-card lens-traces-cluster-card-back lens-traces-cluster-card-back-2${expanded ? " open" : ""}`}
        aria-hidden="true"
      />
      <div
        className={`lens-traces-cluster-card lens-traces-cluster-card-back lens-traces-cluster-card-back-1${expanded ? " open" : ""}`}
        aria-hidden="true"
      />
      <div
        className="lens-traces-cluster-card lens-traces-cluster-card-front"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={handleToggle}
        onKeyDown={handleKeyDown}
      >
        <div className="lens-traces-cluster-main">
          <span className={`lens-traces-health-dot lens-traces-health-dot-${isError ? "error" : "ok"}`} />
          <span className="lens-traces-cluster-route">{cluster.route}</span>
          <span className={`lens-traces-trace-status lens-traces-trace-status-${isError ? "error" : "ok"}`}>
            {cluster.status}
          </span>
          <span className="lens-traces-cluster-count">×{cluster.count}</span>
          <span className="lens-traces-cluster-duration">
            {t("evidence.traces.clusterAvg", { duration: cluster.avgDurationMs })}
          </span>
        </div>
        <span className="lens-traces-cluster-toggle">
          {expanded ? t("evidence.traces.collapseGroup") : t("evidence.traces.expandGroup")}
        </span>
      </div>

      {expanded && (
        <div className="lens-traces-cluster-list">
          {cluster.groups.map((group) => (
            <TraceGroupBlock
              key={group.traceId}
              group={group}
              smokingGunSpanId={smokingGunSpanId}
              isExpected={isExpected}
              proofType={proofType}
              selectedTargetId={selectedTargetId}
            />
          ))}
        </div>
      )}
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
  const { t } = useTranslation();
  const [baselineVisible, setBaselineVisible] = useState(false);
  const search = useLensSearch();
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
      ? t("evidence.traces.baselineUnavailable")
      : t("evidence.traces.baselineSparse")
    : baselineVisible
      ? t("evidence.traces.hideExpected")
      : t("evidence.traces.showExpected");

  return (
    <div className="lens-traces-root">
      {observed.length === 0 ? (
        <div className="lens-traces-empty">
          {evidenceDensity === "empty"
            ? t("evidence.traces.emptyObserved")
            : t("evidence.traces.limitedTraces")}
        </div>
      ) : (
        buildTraceClusters(observed).map((cluster) => (
          <TraceClusterBlock
            key={cluster.key}
            cluster={cluster}
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
          buildTraceClusters(expected).map((cluster) => (
            <TraceClusterBlock
              key={cluster.key}
              cluster={cluster}
              smokingGunSpanId={null}
              isExpected
              proofType="recovery"
              selectedTargetId={selectedTargetId}
            />
          ))
        ) : (
          <div className="lens-traces-empty lens-traces-empty-baseline">
            {baselineState === "unavailable"
              ? t("evidence.traces.noBaseline")
              : t("evidence.traces.baselineTooSparse")}
          </div>
        )}
      </div>
    </div>
  );
}
