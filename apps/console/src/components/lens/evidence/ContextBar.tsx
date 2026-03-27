import { useTranslation } from "react-i18next";
import type { ExtendedIncident } from "../../../api/curated-types.js";

interface Props {
  incident: ExtendedIncident;
}

/**
 * ContextBar — accent-soft strip keeping incident context visible at top of Evidence Studio.
 * Shows health dot + incident ID (mono) + em-dash + headline + action summary.
 */
export function ContextBar({ incident }: Props) {
  const { t } = useTranslation();
  const headline = incident.headline.trim() || t("evidence.contextBarFallback");
  const actionText = incident.action.text.trim();

  return (
    <div className="lens-ev-context-bar" role="region" aria-label={t("evidence.contextBarLabel")}>
      <span
        className={`lens-ev-health-dot lens-ev-health-dot-${incident.severity}`}
        aria-hidden="true"
      />
      <span className="lens-ev-ctx-id">{incident.incidentId}</span>
      <span className="lens-ev-ctx-sep" aria-hidden="true">&mdash;</span>
      <span className="lens-ev-ctx-headline">{headline}</span>
      {actionText && (
        <span className="lens-ev-ctx-action">
          {t("evidence.contextBarAction", { text: actionText })}
        </span>
      )}
    </div>
  );
}
