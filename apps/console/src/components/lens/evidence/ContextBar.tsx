import { useTranslation } from "react-i18next";
import type { ExtendedIncident } from "../../../api/curated-types.js";
import { formatShortIncidentId } from "../../../lib/incidentId.js";
import { extractTitle } from "../../../lib/headline.js";

interface Props {
  incident: ExtendedIncident;
}

/**
 * ContextBar — compact incident anchor for Evidence Studio.
 * Keeps only severity, incident ID, and the short title visible.
 */
export function ContextBar({ incident }: Props) {
  const { t } = useTranslation();
  const headline = extractTitle(incident.headline) || t("evidence.contextBarFallback");

  return (
    <div className="lens-ev-context-bar" role="region" aria-label={t("evidence.contextBarLabel")}>
      <span
        className={`lens-ev-health-dot lens-ev-health-dot-${incident.severity}`}
        aria-hidden="true"
      />
      <span className="lens-ev-ctx-id">{formatShortIncidentId(incident.incidentId)}</span>
      <span className="lens-ev-ctx-sep" aria-hidden="true">&mdash;</span>
      <span className="lens-ev-ctx-headline">{headline}</span>
    </div>
  );
}
