import type { ExtendedIncident } from "../../../api/curated-types.js";

interface Props {
  incident: ExtendedIncident;
}

/**
 * ContextBar — accent-soft strip keeping incident context visible at top of Evidence Studio.
 * Shows health dot + incident ID (mono) + em-dash + headline + action summary.
 */
export function ContextBar({ incident }: Props) {
  const headline = incident.headline.trim() || "Evidence Studio is waiting for a diagnosis narrative.";
  const actionText = incident.action.text.trim();

  return (
    <div className="lens-ev-context-bar" role="region" aria-label="Incident context">
      <span
        className={`lens-ev-health-dot lens-ev-health-dot-${incident.severity}`}
        aria-hidden="true"
      />
      <span className="lens-ev-ctx-id">{incident.incidentId}</span>
      <span className="lens-ev-ctx-sep" aria-hidden="true">&mdash;</span>
      <span className="lens-ev-ctx-headline">{headline}</span>
      {actionText && (
        <span className="lens-ev-ctx-action">
          Action: {actionText}
        </span>
      )}
    </div>
  );
}
