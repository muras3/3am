import type { IncidentPacket, DiagnosisResult, PlatformEvent, ThinEvent, ChangedMetric, RelevantLog } from "@3amoncall/core";
import type { ExtractedSpan } from "../../domain/anomaly-detector.js";
import type { AnomalousSignal, Incident, IncidentPage, IncidentRawState, StorageDriver } from "../interface.js";
import { createEmptyRawState } from "../interface.js";

export class MemoryAdapter implements StorageDriver {
  private incidents: Map<string, Incident> = new Map();
  private packetIndex: Map<string, string> = new Map(); // packetId → incidentId
  private thinEvents: ThinEvent[] = [];

  async createIncident(packet: IncidentPacket): Promise<void> {
    const existing = this.incidents.get(packet.incidentId);
    if (existing) {
      // Upsert: update packet but preserve diagnosisResult, openedAt, and rawState
      this.incidents.set(packet.incidentId, {
        ...existing,
        packet,
      });
    } else {
      this.incidents.set(packet.incidentId, {
        incidentId: packet.incidentId,
        status: "open",
        openedAt: packet.openedAt,
        packet,
        rawState: createEmptyRawState(),
      });
    }
    this.packetIndex.set(packet.packetId, packet.incidentId);
  }

  async updateIncidentStatus(
    id: string,
    status: "open" | "closed",
  ): Promise<void> {
    const incident = this.incidents.get(id);
    if (!incident) return;
    this.incidents.set(id, {
      ...incident,
      status,
      ...(status === "closed" ? { closedAt: new Date().toISOString() } : {}),
    });
  }

  async appendDiagnosis(id: string, result: DiagnosisResult): Promise<void> {
    const incident = this.incidents.get(id);
    if (!incident) return;
    this.incidents.set(id, {
      ...incident,
      diagnosisResult: result,
    });
  }

  async appendRawEvidence(
    id: string,
    update: { metricEvidence?: ChangedMetric[]; logEvidence?: RelevantLog[] },
  ): Promise<void> {
    const incident = this.incidents.get(id);
    if (!incident) return;
    if (update.metricEvidence) incident.rawState.metricEvidence.push(...update.metricEvidence);
    if (update.logEvidence) incident.rawState.logEvidence.push(...update.logEvidence);
  }

  async appendSpans(incidentId: string, spans: ExtractedSpan[]): Promise<void> {
    const incident = this.incidents.get(incidentId);
    if (!incident) return;
    incident.rawState.spans.push(...spans);
  }

  async appendAnomalousSignals(incidentId: string, signals: AnomalousSignal[]): Promise<void> {
    const incident = this.incidents.get(incidentId);
    if (!incident) return;
    incident.rawState.anomalousSignals.push(...signals);
  }

  async appendPlatformEvents(incidentId: string, events: PlatformEvent[]): Promise<void> {
    const incident = this.incidents.get(incidentId);
    if (!incident) return;
    incident.rawState.platformEvents.push(...events);
  }

  async getRawState(incidentId: string): Promise<IncidentRawState | null> {
    return this.incidents.get(incidentId)?.rawState ?? null;
  }

  async listIncidents(opts: {
    limit: number;
    cursor?: string;
  }): Promise<IncidentPage> {
    // Sort by openedAt descending
    const sorted = Array.from(this.incidents.values()).sort(
      (a, b) =>
        new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime(),
    );

    const offset = opts.cursor !== undefined ? parseInt(opts.cursor, 10) : 0;
    const slice = sorted.slice(offset, offset + opts.limit);
    const nextOffset = offset + opts.limit;
    const hasMore = nextOffset < sorted.length;

    return {
      items: slice,
      nextCursor: hasMore ? String(nextOffset) : undefined,
    };
  }

  async getIncident(id: string): Promise<Incident | null> {
    return this.incidents.get(id) ?? null;
  }

  async getIncidentByPacketId(packetId: string): Promise<Incident | null> {
    const incidentId = this.packetIndex.get(packetId);
    if (!incidentId) return null;
    return this.incidents.get(incidentId) ?? null;
  }

  async deleteExpiredIncidents(before: Date): Promise<void> {
    for (const [id, incident] of this.incidents) {
      if (
        incident.status === "closed" &&
        new Date(incident.openedAt) < before
      ) {
        this.incidents.delete(id);
      }
    }
  }

  async saveThinEvent(event: ThinEvent): Promise<void> {
    if (this.thinEvents.some((e) => e.event_id === event.event_id)) {
      throw new Error(`Duplicate event_id: ${event.event_id}`);
    }
    this.thinEvents.push(event);
  }

  async listThinEvents(): Promise<ThinEvent[]> {
    return [...this.thinEvents];
  }
}
