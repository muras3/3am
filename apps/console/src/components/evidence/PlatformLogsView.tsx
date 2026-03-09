import type { Incident } from "../../api/types.js";

interface Props {
  incident: Incident;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function PlatformLogsView({ incident }: Props) {
  return (
    <div className="pflogs-table">
      <div className="pflogs-head">
        <span>Time</span>
        <span>Plane</span>
        <span>Details</span>
        <span>Role</span>
      </div>
      <div className="pflogs-body">
        <div className="pflogs-empty">
          No platform events captured for this incident.
        </div>
      </div>
    </div>
  );
}
