import { useCallback, useEffect, useRef, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { curatedQueries } from "../../api/queries.js";
import { useLensSearch, type LensLevel, type LensSearchParams } from "../../routes/__root.js";
import { LevelHeader } from "./LevelHeader.js";
import { ZoomNav } from "./ZoomNav.js";
import { MapView } from "./map/MapView.js";

const LensIncidentBoard = lazy(() =>
  import("./board/LensIncidentBoard.js").then((m) => ({ default: m.LensIncidentBoard })),
);

const LensEvidenceStudio = lazy(() =>
  import("./evidence/LensEvidenceStudio.js").then((m) => ({ default: m.LensEvidenceStudio })),
);

/**
 * LensShell — 3-level zoom navigation shell.
 *
 * Renders three full-screen `.level` sections (Map / Incident / Evidence).
 * Only one is `.active` at a time; transitions use CSS scale + blur + opacity.
 * The shell owns zoom navigation, focus management, and Escape handling.
 */
export function LensShell() {
  const { t } = useTranslation();
  const search = useLensSearch();
  const { level, incidentId } = search;
  const navigate = useNavigate();
  const { data: incidentMeta } = useQuery({
    ...curatedQueries.extendedIncident(incidentId ?? ""),
    enabled: !!incidentId,
  });

  // Refs for focus management
  const levelRefs = useRef<(HTMLElement | null)[]>([null, null, null]);
  const lastTriggerRef = useRef<HTMLElement | null>(null);
  const isFirstRender = useRef(true);

  const zoomTo = useCallback(
    (targetLevel: LensLevel, triggerElement?: HTMLElement, targetIncidentId?: string) => {
      if (triggerElement) {
        lastTriggerRef.current = triggerElement;
      }

      // Use provided incidentId (from map click) or keep current
      const resolvedIncidentId = targetIncidentId ?? search.incidentId;

      // Build full search params — going back strips deeper-level params
      const next: LensSearchParams = {
        level: targetLevel,
        incidentId: targetLevel >= 1 ? resolvedIncidentId : undefined,
        tab: targetLevel >= 2 ? search.tab : "traces",
        proof: targetLevel >= 2 ? search.proof : undefined,
        targetId: targetLevel >= 2 ? search.targetId : undefined,
        query: targetLevel >= 2 ? search.query : undefined,
      };

      void navigate({
        to: "/",
        search: next,
        replace: true,
      });
    },
    [navigate, search.incidentId, search.tab, search.proof, search.targetId, search.query],
  );

  // Focus management on level change
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    // Small delay to allow CSS transition to start
    const timer = setTimeout(() => {
      const target = levelRefs.current[level];
      if (target) {
        // Focus the first focusable element or the level container itself
        const focusTarget =
          target.querySelector<HTMLElement>("h1, [data-focus-target]") ?? target;
        focusTarget.focus({ preventScroll: true });
      }
    }, 60);

    return () => clearTimeout(timer);
  }, [level]);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Skip when focus is in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.key === "Escape" && level > 0) {
        e.preventDefault();
        zoomTo((level - 1) as LensLevel);
        return;
      }

      // Level 0: j/k to navigate incident rows, Enter to zoom
      if (level === 0 && (e.key === "j" || e.key === "k")) {
        e.preventDefault();
        const rows = Array.from(document.querySelectorAll<HTMLElement>(".incident-row[role='button']"));
        if (rows.length === 0) return;
        const focused = document.activeElement as HTMLElement;
        const idx = rows.indexOf(focused);
        const next = e.key === "j" ? Math.min(idx + 1, rows.length - 1) : Math.max(idx - 1, 0);
        rows[idx === -1 ? 0 : next]?.focus();
        return;
      }

      // Level 2: 1/2/3 to switch evidence tabs
      if (level === 2 && (e.key === "1" || e.key === "2" || e.key === "3")) {
        e.preventDefault();
        const tabs = ["traces", "metrics", "logs"] as const;
        const targetTab = tabs[Number(e.key) - 1];
        if (targetTab) {
          void navigate({ to: "/", search: { ...search, tab: targetTab }, replace: true });
        }
        return;
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [level, zoomTo, navigate, search]);

  return (
    <div className="lens-world">
      <section
        ref={(el) => { levelRefs.current[0] = el; }}
        className={levelClass(0, level)}
        aria-hidden={level !== 0}
        inert={level !== 0 || undefined}
        tabIndex={-1}
      >
        <LevelHeader level={0} zoomTo={zoomTo} />
        <div className="level-content" data-focus-target>
          <MapView zoomTo={zoomTo} />
        </div>
      </section>

      <section
        ref={(el) => { levelRefs.current[1] = el; }}
        className={levelClass(1, level)}
        aria-hidden={level !== 1}
        inert={level !== 1 || undefined}
        tabIndex={-1}
      >
        <LevelHeader
          level={1}
          incidentId={incidentId}
          severity={incidentMeta?.severity}
          openedAt={incidentMeta?.openedAt}
          zoomTo={zoomTo}
        />
        <div className="level-content" data-focus-target>
          <Suspense fallback={<div className="level-placeholder">{t("common.loading")}</div>}>
            {incidentId ? (
              <LensIncidentBoard incidentId={incidentId} zoomTo={zoomTo} />
            ) : (
              <div className="level-placeholder">{t("shell.selectIncident")}</div>
            )}
          </Suspense>
        </div>
      </section>

      <section
        ref={(el) => { levelRefs.current[2] = el; }}
        className={levelClass(2, level)}
        aria-hidden={level !== 2}
        inert={level !== 2 || undefined}
        tabIndex={-1}
      >
        <LevelHeader
          level={2}
          incidentId={incidentId}
          severity={incidentMeta?.severity}
          zoomTo={zoomTo}
        />
        <div className="level-content" data-focus-target>
          <Suspense fallback={<div className="level-placeholder">{t("common.loading")}</div>}>
            {incidentId ? (
              <LensEvidenceStudio incidentId={incidentId} zoomTo={zoomTo} />
            ) : (
              <div className="level-placeholder">{t("shell.selectIncidentEvidence")}</div>
            )}
          </Suspense>
        </div>
      </section>

      <ZoomNav level={level} zoomTo={zoomTo} incidentId={incidentId} />
    </div>
  );
}

function levelClass(thisLevel: number, activeLevel: number): string {
  if (thisLevel === activeLevel) return "level active";
  if (thisLevel < activeLevel) return "level zoomed-past";
  return "level";
}
