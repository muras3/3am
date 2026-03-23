import { useEffect } from "react";
import { useSearch } from "@tanstack/react-router";
import type { LogsSurface, LogClaim, LogEntry } from "../../../api/curated-types.js";
import type { LensSearchParams } from "../../../routes/__root.js";

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
      <span className="lens-logs-claim-count">{claim.count}&nbsp;entries</span>
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

// ── Single claim cluster ──────────────────────────────────────
interface ClaimClusterProps {
  claim: LogClaim;
  activeProofId?: string;
  activeTargetId?: string;
}

function ClaimCluster({ claim, activeProofId, activeTargetId }: ClaimClusterProps) {
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
              Expected: {claim.expected ?? claim.label}. Observed: {claim.observed ?? "none"}.
            </em>
          </p>
          {claim.explanation && (
            <p className="lens-logs-absence-text">{claim.explanation}</p>
          )}
        </div>
      ) : (
        /* Normal entries */
        <div className="lens-logs-entries">
          {claim.entries.map((entry, i) => (
            <LogRow key={`${entry.timestamp}-${i}`} entry={entry} />
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

  if (surface.claims.length === 0) {
    return (
      <div className="lens-logs-empty">
        {evidenceDensity === "empty"
          ? "Log clusters are reserved here. When the first repeated pattern or notable absence is confirmed, it will pin into this lane."
          : "Log evidence is still sparse. Treat this lane as open for corroboration rather than as proof of health."}
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
