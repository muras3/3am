import type { IncidentPacket, DiagnosisResult, ConsoleNarrative, PlatformEvent, ThinEvent } from "3am-core";
import type { AnomalousSignal, Incident, IncidentPage, InitialMembership, StorageDriver } from "../interface.js";
import { MAX_ANOMALOUS_SIGNALS, MAX_SPAN_MEMBERSHIP } from "../interface.js";

export class MemoryAdapter implements StorageDriver {
  private incidents: Map<string, Incident> = new Map();
  private packetIndex: Map<string, string> = new Map(); // packetId → incidentId
  private thinEvents: ThinEvent[] = [];
  private settings: Map<string, string> = new Map();
  private rateLimitBuckets: Map<string, { bucketStart: number; count: number }> = new Map();
  private nextIncidentSequenceValue = 1;

  async nextIncidentSequence(): Promise<number> {
    const value = this.nextIncidentSequenceValue;
    this.nextIncidentSequenceValue += 1;
    return value;
  }

  async createIncident(packet: IncidentPacket, membership: InitialMembership): Promise<void> {
    if (this.incidents.has(packet.incidentId)) return; // no-op if already exists
    this.incidents.set(packet.incidentId, {
      incidentId: packet.incidentId,
      status: "open",
      openedAt: packet.openedAt,
      lastActivityAt: packet.openedAt,
      packet,
      telemetryScope: membership.telemetryScope,
      spanMembership: [...membership.spanMembership],
      anomalousSignals: [...membership.anomalousSignals],
      platformEvents: [],
    });
    this.packetIndex.set(packet.packetId, packet.incidentId);
    const sequence = parseIncidentSequence(packet.incidentId);
    if (sequence !== null) {
      this.nextIncidentSequenceValue = Math.max(this.nextIncidentSequenceValue, sequence + 1);
    }
  }

  async updatePacket(incidentId: string, packet: IncidentPacket): Promise<void> {
    const incident = this.incidents.get(incidentId);
    if (!incident) return;
    this.incidents.set(incidentId, { ...incident, packet });
    this.packetIndex.set(packet.packetId, incidentId);
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
      ...(status === "closed"
        ? { closedAt: new Date().toISOString() }
        : { closedAt: undefined }),
    });
  }

  async touchIncidentActivity(id: string, at = new Date().toISOString()): Promise<void> {
    const incident = this.incidents.get(id);
    if (!incident) return;
    this.incidents.set(id, {
      ...incident,
      lastActivityAt: at,
    });
  }

  async appendDiagnosis(id: string, result: DiagnosisResult): Promise<void> {
    const incident = this.incidents.get(id);
    if (!incident) return;
    this.incidents.set(id, {
      ...incident,
      diagnosisResult: result,
      diagnosisScheduledAt: undefined,
      diagnosisDispatchedAt: undefined,
    });
  }

  async appendConsoleNarrative(id: string, narrative: ConsoleNarrative): Promise<void> {
    const incident = this.incidents.get(id);
    if (!incident) return;
    this.incidents.set(id, {
      ...incident,
      consoleNarrative: narrative,
    });
  }

  async expandTelemetryScope(
    incidentId: string,
    expansion: { windowStartMs: number; windowEndMs: number; memberServices: string[]; dependencyServices: string[] },
  ): Promise<void> {
    const incident = this.incidents.get(incidentId);
    if (!incident) return;
    const scope = incident.telemetryScope;
    const memberSet = new Set(scope.memberServices);
    for (const s of expansion.memberServices) memberSet.add(s);
    const depSet = new Set(scope.dependencyServices);
    for (const s of expansion.dependencyServices) depSet.add(s);
    incident.telemetryScope = {
      ...scope,
      windowStartMs: Math.min(scope.windowStartMs, expansion.windowStartMs),
      windowEndMs: Math.max(scope.windowEndMs, expansion.windowEndMs),
      memberServices: [...memberSet],
      dependencyServices: [...depSet],
    };
  }

  async appendSpanMembership(incidentId: string, spanIds: string[]): Promise<void> {
    const incident = this.incidents.get(incidentId);
    if (!incident) return;
    const existing = new Set(incident.spanMembership);
    for (const id of spanIds) {
      if (!existing.has(id)) {
        incident.spanMembership.push(id);
        existing.add(id);
      }
    }
    // Cap: drop oldest entries when exceeding MAX_SPAN_MEMBERSHIP
    if (incident.spanMembership.length > MAX_SPAN_MEMBERSHIP) {
      incident.spanMembership.splice(0, incident.spanMembership.length - MAX_SPAN_MEMBERSHIP);
    }
  }

  async appendAnomalousSignals(incidentId: string, signals: AnomalousSignal[]): Promise<void> {
    const incident = this.incidents.get(incidentId);
    if (!incident) return;
    incident.anomalousSignals.push(...signals);
    // Cap: drop oldest entries when exceeding MAX_ANOMALOUS_SIGNALS
    if (incident.anomalousSignals.length > MAX_ANOMALOUS_SIGNALS) {
      incident.anomalousSignals.splice(0, incident.anomalousSignals.length - MAX_ANOMALOUS_SIGNALS);
    }
  }

  async appendPlatformEvents(incidentId: string, events: PlatformEvent[]): Promise<void> {
    const incident = this.incidents.get(incidentId);
    if (!incident) return;
    incident.platformEvents.push(...events);
  }

  private materializationClaims = new Map<string, number>();

  async claimMaterializationLease(incidentId: string, leaseMs = 60_000): Promise<boolean> {
    const existing = this.materializationClaims.get(incidentId);
    if (existing !== undefined && existing + leaseMs > Date.now()) return false;
    this.materializationClaims.set(incidentId, Date.now());
    return true;
  }

  async releaseMaterializationLease(incidentId: string): Promise<void> {
    this.materializationClaims.delete(incidentId);
  }

  async claimDiagnosisDispatch(incidentId: string, leaseMs = 15 * 60_000): Promise<boolean> {
    const incident = this.incidents.get(incidentId);
    if (!incident) return false;
    if (incident.diagnosisDispatchedAt) {
      const claimedAt = new Date(incident.diagnosisDispatchedAt).getTime();
      if (Number.isFinite(claimedAt) && claimedAt + leaseMs > Date.now()) return false;
    }
    incident.diagnosisDispatchedAt = new Date().toISOString();
    return true;
  }

  async releaseDiagnosisDispatch(incidentId: string): Promise<void> {
    const incident = this.incidents.get(incidentId);
    if (!incident) return;
    incident.diagnosisDispatchedAt = undefined;
  }

  async markDiagnosisScheduled(incidentId: string, at?: string): Promise<void> {
    const incident = this.incidents.get(incidentId);
    if (!incident) return;
    if (incident.diagnosisScheduledAt) return; // already set — idempotent
    incident.diagnosisScheduledAt = at ?? new Date().toISOString();
  }

  async clearDiagnosisScheduled(incidentId: string): Promise<void> {
    const incident = this.incidents.get(incidentId);
    if (!incident) return;
    incident.diagnosisScheduledAt = undefined;
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
        incident.closedAt !== undefined &&
        new Date(incident.closedAt) < before
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

  async getSettings(key: string): Promise<string | null> {
    return this.settings.get(key) ?? null;
  }

  async setSettings(key: string, value: string): Promise<void> {
    this.settings.set(key, value);
  }

  async consumeRateLimit(key: string, windowMs: number, max: number, now = Date.now()): Promise<boolean> {
    const bucketStart = now - (now % windowMs);
    const existing = this.rateLimitBuckets.get(key);
    if (!existing || existing.bucketStart !== bucketStart) {
      this.rateLimitBuckets.set(key, { bucketStart, count: 1 });
      return true;
    }
    if (existing.count >= max) return false;
    existing.count += 1;
    return true;
  }
}

function parseIncidentSequence(incidentId: string): number | null {
  const match = incidentId.match(/^inc_(\d{6})$/);
  const digits = match?.[1];
  return digits ? Number.parseInt(digits, 10) : null;
}
