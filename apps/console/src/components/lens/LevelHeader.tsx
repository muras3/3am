import { useEffect, useState } from "react";
import type { LensLevel } from "../../routes/__root.js";

interface LevelHeaderProps {
  level: LensLevel;
  incidentId?: string;
  severity?: string;
  openedAt?: string;
  zoomTo: (level: LensLevel, trigger?: HTMLElement) => void;
}

/**
 * LevelHeader — level-aware header bar.
 *
 * - Level 0 (Map): logo + env tag + clock
 * - Level 1 (Incident): back + incident ID + severity + duration + clock
 * - Level 2 (Evidence): back + "Evidence Studio" + severity + clock
 */
export function LevelHeader({
  level,
  incidentId,
  severity,
  openedAt,
  zoomTo,
}: LevelHeaderProps) {
  const clock = useClock();

  if (level === 0) {
    return (
      <header className="level-header">
        <div className="topbar-logo">
          <span className="pulse" />
          3amoncall
        </div>
        <span className="topbar-sep" />
        <span className="env-tag">production</span>
        <span className="level-header-clock">{clock}</span>
      </header>
    );
  }

  if (level === 1) {
    return (
      <header className="level-header">
        <button
          className="back-btn"
          onClick={(e) => zoomTo(0, e.currentTarget)}
          aria-label="Back to Map"
        >
          ← Map
        </button>
        <span className="topbar-sep" />
        {incidentId && (
          <span className="level-header-id">{incidentId.replace("inc_", "INC-")}</span>
        )}
        {severity && (
          <span className="severity-badge" data-severity={severity}>
            {severity}
          </span>
        )}
        {openedAt && <Duration openedAt={openedAt} />}
        <span className="level-header-clock">{clock}</span>
      </header>
    );
  }

  // Level 2
  return (
    <header className="level-header">
      <button
        className="back-btn"
        onClick={(e) => zoomTo(1, e.currentTarget)}
        aria-label="Back to Incident"
      >
        ← {incidentId ? incidentId.replace("inc_", "INC-") : "Incident"}
      </button>
      <span className="topbar-sep" />
      <span className="level-header-title">Evidence Studio</span>
      {severity && (
        <span className="severity-badge" data-severity={severity}>
          {severity}
        </span>
      )}
      <span className="level-header-clock">{clock}</span>
    </header>
  );
}

// ── Clock ─────────────────────────────────────────────────────

function useClock(): string {
  const [now, setNow] = useState(() => formatTime(new Date()));
  useEffect(() => {
    const id = setInterval(() => setNow(formatTime(new Date())), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function formatTime(d: Date): string {
  return d.toISOString().slice(11, 19) + " UTC";
}

// ── Duration ──────────────────────────────────────────────────

function Duration({ openedAt }: { openedAt: string }) {
  const [text, setText] = useState(() => formatDuration(openedAt));
  useEffect(() => {
    const id = setInterval(() => setText(formatDuration(openedAt)), 1000);
    return () => clearInterval(id);
  }, [openedAt]);

  return <span className="level-header-duration">{text}</span>;
}

function formatDuration(openedAt: string): string {
  const elapsed = Math.max(0, Date.now() - new Date(openedAt).getTime());
  const s = Math.floor(elapsed / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m ${s % 60}s`;
}
