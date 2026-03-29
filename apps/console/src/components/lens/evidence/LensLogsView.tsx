import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LogsSurface, LogClaim, LogEntry } from "../../../api/curated-types.js";
import { useLensSearch } from "../../../routes/__root.js";

type ClaimType = LogClaim["type"];

// ── Type icons ────────────────────────────────────────────────
const TYPE_ICON: Record<ClaimType, string> = {
  trigger: "⚡",
  cascade: "⚠",
  recovery: "✓",
  absence: "🔍",
};

// ── Claim cluster header ──────────────────────────────────────
interface ClaimHeaderProps {
  claim: LogClaim;
}

function ClaimHeader({ claim }: ClaimHeaderProps) {
  const { t } = useTranslation();
  const isAbsence = claim.type === "absence";

  return (
    <div
      className={`lens-logs-claim-header lens-logs-claim-header-${claim.type}${isAbsence ? " absence" : ""}`}
    >
      <span className="lens-logs-claim-icon" aria-hidden="true">
        {TYPE_ICON[claim.type]}
      </span>
      <span className={`lens-logs-claim-label lens-logs-claim-label-${claim.type}`}>
        {claim.label}
      </span>
      <span className="lens-logs-claim-count">{t("evidence.logs.entries", { count: claim.count })}</span>
    </div>
  );
}

// ── Single log entry row ──────────────────────────────────────
interface LogRowProps {
  entry: LogEntry;
}

function LogRow({ entry }: LogRowProps) {
  const rowClass = [
    "lens-logs-log-row",
    entry.signal ? "signal" : "noise",
  ].join(" ");

  return (
    <div className={rowClass}>
      <span className="lens-logs-log-time">{entry.timestamp}</span>
      <span
        className={`lens-logs-log-sev lens-logs-log-sev-${entry.severity}`}
      >
        {entry.severity.toUpperCase()}
      </span>
      <span className="lens-logs-log-body">{entry.body}</span>
    </div>
  );
}

interface EntryCluster {
  key: string;
  severity: string;
  representativeBody: string;
  count: number;
  entries: LogEntry[];
  highlighted: boolean;
  latestTimestamp: string;
}

function normalizeLogBody(body: string): string {
  return body
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, "<time>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<id>")
    .replace(/\b\d+\b/g, "<num>")
    .trim();
}

function buildEntryClusters(entries: LogEntry[]): EntryCluster[] {
  const clusters = new Map<string, EntryCluster>();
  for (const entry of entries) {
    const normalized = normalizeLogBody(entry.body);
    const key = `${entry.severity}::${normalized}`;
    const current = clusters.get(key);
    if (current) {
      current.count += 1;
      current.entries.push(entry);
      current.highlighted = current.highlighted || entry.signal;
      current.latestTimestamp = current.latestTimestamp > entry.timestamp
        ? current.latestTimestamp
        : entry.timestamp;
      continue;
    }
    clusters.set(key, {
      key,
      severity: entry.severity,
      representativeBody: entry.body,
      count: 1,
      entries: [entry],
      highlighted: entry.signal,
      latestTimestamp: entry.timestamp,
    });
  }
  return [...clusters.values()];
}

function EntryClusterBlock({ cluster }: { cluster: EntryCluster }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(cluster.count === 1);
  const toggle = useCallback(() => {
    if (cluster.count <= 1) return;
    setExpanded((value) => !value);
  }, [cluster.count]);
  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (cluster.count <= 1) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  }, [cluster.count, toggle]);

  return (
    <div className={`lens-logs-entry-cluster${cluster.highlighted ? " proof-highlight" : ""}${expanded ? " open" : ""}`}>
      <div
        className="lens-logs-entry-cluster-card"
        role={cluster.count > 1 ? "button" : undefined}
        tabIndex={cluster.count > 1 ? 0 : undefined}
        aria-expanded={cluster.count > 1 ? expanded : undefined}
        onClick={toggle}
        onKeyDown={handleKeyDown}
      >
        <div className="lens-logs-entry-cluster-main">
          <span className={`lens-logs-log-sev lens-logs-log-sev-${cluster.severity}`}>{cluster.severity.toUpperCase()}</span>
          <span className="lens-logs-log-time">{cluster.latestTimestamp}</span>
          <span className="lens-logs-entry-cluster-body">{cluster.representativeBody}</span>
          {cluster.count > 1 && <span className="lens-logs-entry-cluster-count">×{cluster.count}</span>}
        </div>
        {cluster.count > 1 && (
          <span className="lens-logs-entry-cluster-toggle">
            {expanded ? t("evidence.logs.collapseGroup") : t("evidence.logs.expandGroup")}
          </span>
        )}
      </div>

      {expanded && cluster.count > 1 && (
        <div className="lens-logs-entry-cluster-list">
          {cluster.entries.map((entry, index) => (
            <LogRow key={`${entry.timestamp}-${index}`} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Single claim cluster ──────────────────────────────────────
interface ClaimClusterProps {
  claim: LogClaim;
  activeProofId?: string;
  activeTargetId?: string;
}

function ClaimCluster({ claim, activeProofId, activeTargetId }: ClaimClusterProps) {
  const { t } = useTranslation();
  const isAbsence = claim.type === "absence";
  const isHighlighted = activeProofId === claim.type || activeTargetId === claim.id;

  return (
    <div
      className={`lens-logs-claim-cluster lens-logs-claim-cluster-${claim.type}${isAbsence ? " absence" : ""}${isHighlighted ? " proof-highlight" : ""}`}
      data-proof={claim.type}
      data-target-id={claim.id}
    >
      <ClaimHeader claim={claim} />

      {isAbsence ? (
        /* Absence evidence: show structured negative finding */
        <div className="lens-logs-absence-body">
          <p className="lens-logs-absence-text">
            <em>
              {t("evidence.logs.expectedLabel", { expected: claim.expected ?? claim.label, observed: claim.observed ?? "—" })}
            </em>
          </p>
          {claim.explanation && (
            <p className="lens-logs-absence-text">{claim.explanation}</p>
          )}
        </div>
      ) : (
        /* Normal entries */
        <div className="lens-logs-entries">
          {buildEntryClusters(claim.entries).map((cluster) => (
            <EntryClusterBlock key={cluster.key} cluster={cluster} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────
interface LensLogsViewProps {
  surface: LogsSurface;
  evidenceDensity?: "rich" | "sparse" | "empty";
  isActive?: boolean;
}

export function LensLogsView({ surface, evidenceDensity = "rich", isActive = false }: LensLogsViewProps) {
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

  if (surface.claims.length === 0) {
    return (
      <div className="lens-logs-empty">
        {evidenceDensity === "empty"
          ? t("evidence.logs.emptyReserved")
          : t("evidence.logs.sparseEvidence")}
      </div>
    );
  }

  return (
    <div className="lens-logs-root">
      {surface.claims.map((claim) => (
        <ClaimCluster
          key={claim.id}
          claim={claim}
          activeProofId={activeProofId}
          activeTargetId={activeTargetId}
        />
      ))}
    </div>
  );
}
