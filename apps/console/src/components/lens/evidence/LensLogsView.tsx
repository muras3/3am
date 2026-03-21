import type { LogsSurface, LogClaim, LogEntry, ClaimType } from "../../../api/curated-types.js";

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
}

function ClaimCluster({ claim }: ClaimClusterProps) {
  const isAbsence = claim.type === "absence";

  return (
    <div
      className={`lens-logs-claim-cluster lens-logs-claim-cluster-${claim.type}${isAbsence ? " absence" : ""}`}
      data-proof={claim.type}
      data-target-id={claim.id}
    >
      <ClaimHeader claim={claim} />

      {isAbsence ? (
        /* Absence evidence: show structured negative finding */
        <div className="lens-logs-absence-body">
          <p className="lens-logs-absence-text">
            <em>Expected: {claim.label}. Observed: none.</em>
          </p>
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
}

export function LensLogsView({ surface }: LensLogsViewProps) {
  if (surface.claims.length === 0) {
    return <div className="lens-logs-empty">No log claims for this incident.</div>;
  }

  return (
    <div className="lens-logs-root">
      {surface.claims.map((claim) => (
        <ClaimCluster key={claim.id} claim={claim} />
      ))}
    </div>
  );
}
