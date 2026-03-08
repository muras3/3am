import type { IncidentPacket, DiagnosisResult, ThinEvent } from "@3amoncall/core";

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

  /** Remove closed incidents where openedAt < before */
  deleteExpiredIncidents(before: Date): Promise<void>;

  saveThinEvent(event: ThinEvent): Promise<void>;

  listThinEvents(): Promise<ThinEvent[]>;
}
