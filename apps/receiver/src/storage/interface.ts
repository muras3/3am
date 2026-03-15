import type { IncidentPacket, DiagnosisResult, PlatformEvent, ThinEvent, ChangedMetric, RelevantLog } from "@3amoncall/core";
import type { ExtractedSpan } from "../domain/anomaly-detector.js";

export interface AnomalousSignal {
  signal: string;       // e.g., "http_429", "http_500", "span_error", "slow_span", "exception"
  firstSeenAt: string;  // ISO timestamp
  entity: string;       // serviceName
  spanId: string;       // originating span
}

export interface IncidentRawState {
  spans: ExtractedSpan[];
  anomalousSignals: AnomalousSignal[];
  metricEvidence: ChangedMetric[];
  logEvidence: RelevantLog[];
  platformEvents: PlatformEvent[];
}

export function createEmptyRawState(): IncidentRawState {
  return { spans: [], anomalousSignals: [], metricEvidence: [], logEvidence: [], platformEvents: [] }
}

export interface Incident {
  incidentId: string;
  status: "open" | "closed";
  openedAt: string;
  closedAt?: string;
  packet: IncidentPacket;
  diagnosisResult?: DiagnosisResult;
  rawState: IncidentRawState;
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
   * Append typed evidence entries to an existing incident's rawState.
   * Unknown incidentId is a no-op (does not throw).
   */
  appendRawEvidence(
    incidentId: string,
    update: { metricEvidence?: ChangedMetric[]; logEvidence?: RelevantLog[] },
  ): Promise<void>;

  appendSpans(incidentId: string, spans: ExtractedSpan[]): Promise<void>;

  appendAnomalousSignals(incidentId: string, signals: AnomalousSignal[]): Promise<void>;

  appendPlatformEvents(incidentId: string, events: PlatformEvent[]): Promise<void>;

  getRawState(incidentId: string): Promise<IncidentRawState | null>;

  saveThinEvent(event: ThinEvent): Promise<void>;

  listThinEvents(): Promise<ThinEvent[]>;
}
