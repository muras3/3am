import type { Incident } from "../../api/types.js";

interface Props {
  incident: Incident;
}

// Placeholder — Worker B will implement the full board
export function IncidentBoard({ incident }: Props) {
  return (
    <div>
      <div className="section-what">
        <div className="headline">{incident.packet.scope.primaryService} incident</div>
      </div>
    </div>
  );
}
