import type { Incident } from "../../api/types.js";

interface Props {
  incident: Incident;
}

export function ImpactTimeline({ incident }: Props) {
  const signals = incident.packet.triggerSignals;
  return (
    <div className="bottom-card">
      <div className="card-title">Impact &amp; Timeline</div>
      {signals.map((s, i) => (
        <div key={i} className="timeline-row">
          <div className="tt">
            {new Date(s.firstSeenAt).toUTCString().slice(17, 25)}
          </div>
          <div className="te">
            {s.signal} @ {s.entity}
          </div>
        </div>
      ))}
      <div
        style={{ marginTop: "6px", fontSize: "10px", color: "var(--ink-3)" }}
      >
        Surface: {incident.packet.scope.affectedServices.join(", ")}
      </div>
    </div>
  );
}
