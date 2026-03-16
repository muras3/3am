import { useEffect, useState, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Incident, ExtractedSpan } from "../../api/types.js";
import { incidentQueries } from "../../api/queries.js";
import {
  buildEvidenceStudioV4VM,
  buildSpanDetailVM,
} from "../../lib/viewmodels/index.js";
import type { TabKey, ProofCardV4VM } from "../../lib/viewmodels/index.js";
import { EvidenceTabs } from "./EvidenceTabs.js";
import { TracesView } from "./TracesView.js";
import { MetricsView } from "./MetricsView.js";
import { LogsView } from "./LogsView.js";
import { PlatformEventsView } from "./PlatformEventsView.js";
import { ProofCards } from "./ProofCards.js";
import { SideRail } from "./SideRail.js";

interface Props {
  incident: Incident;
  onClose: () => void;
}

const EMPTY_TAB_COUNTS: Record<TabKey, number> = {
  traces: 0,
  metrics: 0,
  logs: 0,
  platform: 0,
};

export function EvidenceStudio({ incident, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<TabKey>("traces");
  const [viewingProofCardId, setViewingProofCardId] = useState<string | null>(null);
  const [selectedSpan, setSelectedSpan] = useState<ExtractedSpan | null>(null);

  const rawQuery = useQuery(incidentQueries.rawEvidence(incident.incidentId));
  const rawState = rawQuery.data?.rawState;

  const vm = useMemo(() => {
    if (!rawState) return null;
    return buildEvidenceStudioV4VM(incident, rawState);
  }, [incident, rawState]);

  const tabCounts = vm?.tabCounts ?? EMPTY_TAB_COUNTS;
  const proofCards = vm?.proofCards ?? [];
  const sideNotes = vm?.sideNotes ?? [];

  // Keyboard: Escape closes
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleProofCardClick = useCallback(
    (card: ProofCardV4VM) => {
      setViewingProofCardId((prev) => (prev === card.id ? null : card.id));
      setActiveTab(card.targetTab);

      if (card.targetId) {
        setTimeout(() => {
          const el = document.querySelector(`[data-target-id="${card.targetId}"]`);
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "nearest" });
            el.classList.add("highlighted", "pulse");
            setTimeout(() => el.classList.remove("pulse"), 800);
          }
        }, 80);
      }
    },
    [],
  );

  const handleSpanSelect = useCallback((span: ExtractedSpan) => {
    setSelectedSpan(span);
  }, []);

  const handleMetricSelect = useCallback((_metric: unknown) => {
    // reserved for future side rail metric detail display
  }, []);

  const spanDetailVM = useMemo(() => {
    if (!selectedSpan || !rawState) return null;
    return buildSpanDetailVM(
      selectedSpan,
      incident.packet.evidence.representativeTraces,
    );
  }, [selectedSpan, rawState, incident.packet.evidence.representativeTraces]);

  const severity = vm?.severity ?? "info";

  return (
    <div className="es-app" data-testid="evidence-studio">
      {/* Row 1: Header */}
      <div className="es-header">
        <div className="es-eyebrow">Evidence Studio</div>
        <div className="es-title">
          <span
            className="severity-badge"
            data-severity={severity}
            aria-label={severity}
          />
          {incident.packet.scope.primaryService}
        </div>
        <button className="btn-close" onClick={onClose} aria-label="Close Evidence Studio">
          Close
        </button>
      </div>

      {/* Row 2: Proof Cards */}
      {rawQuery.isLoading ? (
        <div className="es-proof-cards" aria-busy="true" data-testid="proof-cards-skeleton">
          {[0, 1, 2].map((i) => (
            <div key={i} className="proof-card" style={{ opacity: 0.4 }}>
              <div className="pc-label">Loading…</div>
            </div>
          ))}
        </div>
      ) : (
        <ProofCards
          cards={proofCards}
          viewingId={viewingProofCardId}
          onCardClick={handleProofCardClick}
        />
      )}

      {/* Row 3: Tabs */}
      <EvidenceTabs
        activeTab={activeTab}
        onTabChange={setActiveTab}
        tabCounts={tabCounts}
      />

      {/* Row 4: Content */}
      <div className="es-content">
        <div className="es-main">
          {activeTab === "traces" && (
            <TracesView
              rawSpans={rawState?.spans ?? []}
              packetTraces={incident.packet.evidence.representativeTraces}
              onSpanSelect={handleSpanSelect}
            />
          )}
          {activeTab === "metrics" && (
            <MetricsView
              rawMetrics={rawState?.metricEvidence ?? []}
              packetMetrics={incident.packet.evidence.changedMetrics}
              onMetricSelect={handleMetricSelect}
            />
          )}
          {activeTab === "logs" && (
            <LogsView
              rawLogs={rawState?.logEvidence ?? []}
              packetLogs={incident.packet.evidence.relevantLogs}
            />
          )}
          {activeTab === "platform" && (
            <PlatformEventsView
              rawEvents={rawState?.platformEvents ?? []}
              packetEvents={incident.packet.evidence.platformEvents}
              onEventSelect={() => {}}
            />
          )}
        </div>

        <SideRail
          notes={sideNotes}
          detailCard={spanDetailVM}
          activeTab={activeTab}
        />
      </div>
    </div>
  );
}

