interface Props {
  activeTab: string;
  onTabChange: (tab: string) => void;
}

const TABS = ["metrics", "traces", "logs", "platform-logs"] as const;

export function EvidenceTabs({ activeTab, onTabChange }: Props) {
  return (
    <div className="evidence-tabs">
      {TABS.map((tab) => (
        <button
          key={tab}
          className={`ev-tab${activeTab === tab ? " active" : ""}`}
          onClick={() => onTabChange(tab)}
        >
          {tab.charAt(0).toUpperCase() + tab.slice(1).replace("-", " ")}
        </button>
      ))}
    </div>
  );
}
