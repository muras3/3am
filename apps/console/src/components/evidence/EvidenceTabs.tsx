import type { TabKey } from "../../lib/viewmodels/index.js";

interface Props {
  activeTab: TabKey;
  onTabChange: (tab: TabKey) => void;
  tabCounts: Record<TabKey, number>;
}

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "traces", label: "Traces" },
  { key: "metrics", label: "Metrics" },
  { key: "logs", label: "Logs" },
  { key: "platform", label: "Platform" },
];

export function EvidenceTabs({ activeTab, onTabChange, tabCounts }: Props) {
  return (
    <div className="es-tabs" data-testid="evidence-tabs">
      {TABS.map(({ key, label }) => (
        <button
          key={key}
          className={`es-tab${activeTab === key ? " active" : ""}`}
          onClick={() => onTabChange(key)}
        >
          {label}
          <span className="tab-count">({tabCounts[key]})</span>
        </button>
      ))}
    </div>
  );
}
