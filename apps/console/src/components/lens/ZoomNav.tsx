import { useTranslation } from "react-i18next";
import type { LensLevel } from "../../routes/__root.js";

interface ZoomNavProps {
  level: LensLevel;
  incidentId?: string | undefined;
  zoomTo: (level: LensLevel, trigger?: HTMLElement, incidentId?: string) => void;
}

const CRUMB_KEYS = [
  { level: 0 as LensLevel, key: "nav.map" },
  { level: 1 as LensLevel, key: "nav.incident" },
  { level: 2 as LensLevel, key: "nav.evidence" },
] as const;

/**
 * ZoomNav — fixed bottom-center breadcrumb bar for zoom navigation.
 */
export function ZoomNav({ level, incidentId, zoomTo }: ZoomNavProps) {
  const { t } = useTranslation();
  return (
    <nav className="zoom-nav" aria-label={t("nav.zoomLabel")}>
      {CRUMB_KEYS.map((crumb, i) => {
        const isActive = crumb.level === level;
        const isReachable =
          crumb.level === 0 ||
          (crumb.level === 1 && !!incidentId) ||
          (crumb.level === 2 && !!incidentId && level >= 1);

        return (
          <span key={crumb.level} className="zoom-nav-item">
            {i > 0 && <span className="zoom-nav-sep" aria-hidden>›</span>}
            <button
              className={`zoom-nav-crumb ${isActive ? "active" : ""}`}
              onClick={(e) => {
                if (isReachable && !isActive) {
                  zoomTo(crumb.level, e.currentTarget);
                }
              }}
              disabled={!isReachable || isActive}
              aria-current={isActive ? "step" : undefined}
              tabIndex={0}
            >
              {t(crumb.key)}
            </button>
          </span>
        );
      })}
    </nav>
  );
}
