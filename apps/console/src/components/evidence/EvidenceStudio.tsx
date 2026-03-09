import { useEffect, useState } from "react";
import type { Incident } from "../../api/types.js";
import { EvidenceTabs } from "./EvidenceTabs.js";
import { TracesView } from "./TracesView.js";
import { MetricsView } from "./MetricsView.js";
import { LogsView } from "./LogsView.js";
import { PlatformLogsView } from "./PlatformLogsView.js";

interface Props {
  incident: Incident;
  onClose: () => void;
}

export function EvidenceStudio({ incident, onClose }: Props) {
  const [activeTab, setActiveTab] = useState("traces");

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="overlay show"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="evidence-modal">
        <div className="modal-header">
          <div className="mh-left">
            <div className="mh-eyebrow">Evidence Studio</div>
            <div className="mh-title">
              {incident.packet.scope.primaryService} evidence
            </div>
          </div>
          <button className="btn-close" onClick={onClose}>
            Close
          </button>
        </div>
        <EvidenceTabs activeTab={activeTab} onTabChange={setActiveTab} />
        <div className="evidence-content">
          <div className="evidence-main">
            {activeTab === "traces" && <TracesView incident={incident} />}
            {activeTab === "metrics" && <MetricsView incident={incident} />}
            {activeTab === "logs" && <LogsView incident={incident} />}
            {activeTab === "platform-logs" && (
              <PlatformLogsView incident={incident} />
            )}
          </div>
          <div className="evidence-side">
            <div style={{ fontSize: "11px", color: "var(--ink-3)" }}>
              {incident.packet.scope.affectedServices.join(", ")}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
