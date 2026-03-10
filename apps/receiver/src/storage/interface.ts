import type { IncidentPacket, DiagnosisResult, ThinEvent } from "@3amoncall/core";

/** Merge new evidence entries into an existing incident packet. */
export function mergeEvidenceIntoPacket(
  packet: IncidentPacket,
  update: { changedMetrics?: unknown[]; relevantLogs?: unknown[] },
): IncidentPacket {
  // Cast to the full evidence type so TypeScript can verify all required fields
  // (representativeTraces, platformEvents) are preserved via the spread.
  // ?? [] guards against missing fields in rows stored by an older schema version.
  const ev = packet.evidence as IncidentPacket["evidence"];
  return {
    ...packet,
    evidence: {
      ...ev,
      changedMetrics: [...(ev.changedMetrics ?? []), ...(update.changedMetrics ?? [])],
      relevantLogs: [...(ev.relevantLogs ?? []), ...(update.relevantLogs ?? [])],
    },
  };
}

export interface Incident {
  incidentId: string;
  status: "open" | "closed";
  openedAt: string;
  closedAt?: string;
  packet: IncidentPacket;
  diagnosisResult?: DiagnosisResult;
}

export interface IncidentPage {
  items: Incident[];
  nextCursor?: string;
}

export interface StorageDriver {
  /** Upsert by incidentId. If incident exists, update packet but keep diagnosisResult and openedAt. */
  createIncident(packet: IncidentPacket): Promise<void>;

  updateIncidentStatus(id: string, status: "open" | "closed"): Promise<void>;

  appendDiagnosis(id: string, result: DiagnosisResult): Promise<void>;

  listIncidents(opts: { limit: number; cursor?: string }): Promise<IncidentPage>;

  getIncident(id: string): Promise<Incident | null>;

  getIncidentByPacketId(packetId: string): Promise<Incident | null>;

  /** Remove closed incidents where openedAt < before */
  deleteExpiredIncidents(before: Date): Promise<void>;

  /**
   * Append evidence entries to an existing incident's packet.
   * Unknown incidentId is a no-op (does not throw).
   */
  appendEvidence(
    incidentId: string,
    update: { changedMetrics?: unknown[]; relevantLogs?: unknown[] },
  ): Promise<void>;

  saveThinEvent(event: ThinEvent): Promise<void>;

  listThinEvents(): Promise<ThinEvent[]>;
}
