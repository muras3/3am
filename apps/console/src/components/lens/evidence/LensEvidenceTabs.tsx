import { useRef } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { EvidenceTab, LensSearchParams } from "../../../routes/__root.js";
import type { EvidenceSurfaces } from "../../../api/curated-types.js";

interface Props {
  surfaces: EvidenceSurfaces;
}

const TAB_IDS: EvidenceTab[] = ["traces", "metrics", "logs"];

function countBadge(surfaces: EvidenceSurfaces, tab: EvidenceTab): number {
  if (tab === "traces") return surfaces.traces.observed.length + surfaces.traces.expected.length;
  if (tab === "metrics") return surfaces.metrics.hypotheses.length;
  if (tab === "logs") {
    return surfaces.logs.claims.reduce((sum, c) => sum + c.count, 0);
  }
  return 0;
}

/**
 * LensEvidenceTabs — WAI-ARIA tabs for Traces / Metrics / Logs.
 * Active tab controlled by URL ?tab= param. Arrow keys for navigation.
 */
export function LensEvidenceTabs({ surfaces }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ from: "__root__" }) as LensSearchParams;
  const activeTab = search.tab ?? "traces";
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const TABS: { id: EvidenceTab; label: string }[] = [
    { id: "traces", label: t("evidence.tabs.traces") },
    { id: "metrics", label: t("evidence.tabs.metrics") },
    { id: "logs", label: t("evidence.tabs.logs") },
  ];

  function activateTab(tab: EvidenceTab) {
    void navigate({
      to: "/",
      search: { ...search, tab },
      replace: true,
    });
  }

  function handleKeyDown(e: React.KeyboardEvent, index: number) {
    let nextIndex: number | null = null;

    if (e.key === "ArrowRight") {
      nextIndex = (index + 1) % TAB_IDS.length;
    } else if (e.key === "ArrowLeft") {
      nextIndex = (index - 1 + TAB_IDS.length) % TAB_IDS.length;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = TAB_IDS.length - 1;
    }

    if (nextIndex !== null) {
      e.preventDefault();
      const tab = TABS[nextIndex];
      if (!tab) return;
      activateTab(tab.id);
      tabRefs.current[nextIndex]?.focus();
    }
  }

  return (
    <div
      role="tablist"
      aria-label={t("evidence.surfacesLabel")}
      className="lens-ev-tabs"
    >
      {TABS.map((tab, index) => {
        const count = countBadge(surfaces, tab.id);
        const isActive = activeTab === tab.id;

        return (
          <button
            key={tab.id}
            ref={(el) => { tabRefs.current[index] = el; }}
            role="tab"
            id={`ev-tab-${tab.id}`}
            aria-selected={isActive}
            aria-controls={`ev-panel-${tab.id}`}
            tabIndex={isActive ? 0 : -1}
            className={`lens-ev-tab${isActive ? " lens-ev-tab-active" : ""}`}
            onClick={() => activateTab(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            type="button"
          >
            {tab.label}
            <span className="lens-ev-tab-count" aria-label={t("evidence.itemsLabel", { count })}>
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
