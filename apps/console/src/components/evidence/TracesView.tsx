import type { ExtractedSpan, RepresentativeTrace } from "../../api/types.js";
import { buildTraceGroups } from "../../lib/viewmodels/index.js";
import { EmptyView } from "./EmptyView.js";

interface Props {
  rawSpans: ExtractedSpan[];
  packetTraces: RepresentativeTrace[];
  onSpanSelect: (span: ExtractedSpan) => void;
}

function barClass(span: ExtractedSpan): string {
  if (span.spanStatusCode === 2) return "wf-bar-error";
  if (span.httpStatusCode === 429) return "wf-bar-429";
  if (span.peerService) return "wf-bar-system";
  return "wf-bar-ok";
}

function httpStatusColor(code: number | undefined): string {
  if (!code) return "";
  if (code >= 500) return "var(--accent)";
  if (code >= 400) return "var(--amber)";
  return "";
}

function spanLabel(span: ExtractedSpan): string {
  return span.spanName ?? span.httpRoute ?? span.spanId.slice(0, 10);
}

interface TraceGroupCardProps {
  traceId: string;
  method?: string;
  route?: string;
  rootStatus: number;
  totalDurationMs: number;
  spanCount: number;
  traceStartMs: number;
  orderedSpans: Array<{ span: ExtractedSpan; depth: number; isAiSelected: boolean }>;
  onSpanSelect: (span: ExtractedSpan) => void;
}

function TraceGroupCard({
  traceId,
  method,
  route,
  rootStatus,
  totalDurationMs,
  spanCount,
  traceStartMs,
  orderedSpans,
  onSpanSelect,
}: TraceGroupCardProps) {
  const statusColor =
    rootStatus >= 500
      ? "var(--accent)"
      : rootStatus >= 400
        ? "var(--amber)"
        : "var(--good)";

  return (
    <div className="trace-group" data-testid="trace-group">
      <div className="tg-header">
        {method && <span className="tg-method">{method}</span>}
        <span className="tg-route">{route ?? traceId.slice(0, 12)}</span>
        <span className="tg-id" title={traceId}>{traceId.slice(0, 8)}…</span>
        <span className="tg-status" style={{ color: statusColor }}>
          {rootStatus}
        </span>
        <span className="tg-dur">{totalDurationMs}ms</span>
        <span className="tg-count">{spanCount} spans</span>
      </div>

      <div className="wf-ruler" aria-hidden="true">
        <span>0</span>
        <span>{Math.round(totalDurationMs / 2)}ms</span>
        <span>{totalDurationMs}ms</span>
      </div>

      {orderedSpans.map(({ span, depth, isAiSelected }, idx) => {
        const leftPct =
          totalDurationMs > 0
            ? ((span.startTimeMs - traceStartMs) / totalDurationMs) * 100
            : 0;
        const widthPct =
          totalDurationMs > 0
            ? Math.max(1, (span.durationMs / totalDurationMs) * 100)
            : 1;

        return (
          <div
            key={span.spanId}
            className={`wf-row${isAiSelected ? " highlighted" : ""}`}
            data-testid="span-row"
            onClick={() => onSpanSelect(span)}
          >
            <div
              className="wf-span-name"
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
            >
              <span
                className="svc-dot"
                style={{ background: span.spanStatusCode === 2 ? "var(--accent)" : "var(--teal)" }}
              />
              <span>{spanLabel(span)}</span>
              {span.spanStatusCode === 2 && (
                <span className="err-badge">ERR</span>
              )}
              {span.httpStatusCode != null && (
                <span
                  className="err-badge"
                  style={{ color: httpStatusColor(span.httpStatusCode), borderColor: httpStatusColor(span.httpStatusCode) }}
                >
                  {span.httpStatusCode}
                </span>
              )}
            </div>
            <div className="wf-bar-area">
              <div
                className={`wf-bar ${barClass(span)}`}
                style={{
                  left: `${leftPct.toFixed(1)}%`,
                  width: `${widthPct.toFixed(1)}%`,
                  animationDelay: `${idx * 25}ms`,
                }}
              />
            </div>
            <div className="wf-duration">{span.durationMs}ms</div>
          </div>
        );
      })}
    </div>
  );
}

export function TracesView({ rawSpans, packetTraces, onSpanSelect }: Props) {
  const groups = buildTraceGroups(rawSpans, packetTraces);

  if (groups.length === 0) {
    return <EmptyView label="trace" />;
  }

  return (
    <div data-testid="traces-view">
      {groups.map((group) => (
        <TraceGroupCard
          key={group.traceId}
          traceId={group.traceId}
          method={group.method}
          route={group.route}
          rootStatus={group.rootStatus}
          totalDurationMs={group.totalDurationMs}
          spanCount={group.spanCount}
          traceStartMs={group.traceStartMs}
          orderedSpans={group.orderedSpans}
          onSpanSelect={onSpanSelect}
        />
      ))}
    </div>
  );
}
