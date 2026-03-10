import type { Incident } from "../../api/types.js";

interface Props {
  incident: Incident;
}

function formatTime(isoString: string): string {
  const match = isoString.match(/T(\d{2}:\d{2}:\d{2})/);
  return match ? match[1] : isoString;
}

const TIMELINE_LIMIT = 10;

export function ImpactTimeline({ incident }: Props) {
  const signals = incident.packet.triggerSignals;
  const visible = signals.slice(0, TIMELINE_LIMIT);
  const overflow = signals.length - TIMELINE_LIMIT;
  return (
    <div className="bottom-card">
      <div className="card-title">Impact &amp; Timeline</div>
      {visible.map((s, i) => (
        <div key={i} className="timeline-row">
          <div className="tt">
            {formatTime(s.firstSeenAt)}
          </div>
          <div className="te">
            {s.signal} @ {s.entity}
          </div>
        </div>
      ))}
      {overflow > 0 && (
        <div className="timeline-overflow">+{overflow} more signals</div>
      )}
      <div
        style={{ marginTop: "6px", fontSize: "10px", color: "var(--ink-3)" }}
      >
        Surface: {incident.packet.scope.affectedServices.join(", ")}
      </div>
    </div>
  );
}
