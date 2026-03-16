import type { ImpactTimelineVM } from "../../lib/viewmodels/index.js";

interface Props {
  timeline: ImpactTimelineVM;
}

export function ImpactTimeline({ timeline }: Props) {
  return (
    <div className="bottom-card" data-section="impact-timeline">
      <div className="card-title">Impact &amp; Timeline</div>
      {timeline.events.map((evt, i) => (
        <div key={i} className="timeline-row">
          <div className="tt">{evt.time}</div>
          <div className="te">{evt.label}</div>
        </div>
      ))}
      {timeline.surface && (
        <div className="timeline-surface">Surface: {timeline.surface}</div>
      )}
    </div>
  );
}
