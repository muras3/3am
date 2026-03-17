import type { IncidentPacket, DiagnosisResult, PlatformEvent, ThinEvent } from "@3amoncall/core";

export interface AnomalousSignal {
  signal: string;       // e.g., "http_429", "http_500", "span_error", "slow_span", "exception"
  firstSeenAt: string;  // ISO timestamp
  entity: string;       // serviceName
  spanId: string;       // originating span
}

// ── Span membership key helper ──

/** Build the canonical "traceId:spanId" string used in spanMembership sets. */
export function spanMembershipKey(traceId: string, spanId: string): string {
  return `${traceId}:${spanId}`;
}

/**
 * Maximum number of span membership entries per incident.
 * Each entry is ~53 bytes in JSON. 5000 entries ≈ ~265 KB, well within the 300 KB target.
 * When exceeded, the oldest entries (earliest in the array) are dropped.
 */
export const MAX_SPAN_MEMBERSHIP = 5_000;

// ── TelemetryScope — compact incident query anchor (replaces rawState window/scope role) ──

export interface TelemetryScope {
  windowStartMs: number;          // monotonically decreasing
  windowEndMs: number;            // monotonically increasing
  detectTimeMs: number;           // first anomalous span time (immutable after creation)
  environment: string;            // immutable after creation
  memberServices: string[];       // formation-matched span serviceNames (monotonically expanding)
  dependencyServices: string[];   // peerService values (for query breadth, monotonically expanding)
}

export function createEmptyTelemetryScope(): TelemetryScope {
  return {
    windowStartMs: Number.MAX_SAFE_INTEGER,
    windowEndMs: 0,
    detectTimeMs: 0,
    environment: "unknown",
    memberServices: [],
    dependencyServices: [],
  };
}

// ── InitialMembership — atomic initial state for new incidents ──

export interface InitialMembership {
  telemetryScope: TelemetryScope;
  spanMembership: string[];          // "traceId:spanId" compact ref set
  anomalousSignals: AnomalousSignal[];
}

// ── Incident ──

export interface Incident {
  incidentId: string;
  status: "open" | "closed";
  openedAt: string;
  closedAt?: string;
  packet: IncidentPacket;
  diagnosisResult?: DiagnosisResult;
  telemetryScope: TelemetryScope;
  spanMembership: string[];          // "traceId:spanId" compact ref set
  anomalousSignals: AnomalousSignal[];
  platformEvents: PlatformEvent[];
}

export interface IncidentPage {
  items: Incident[];
  nextCursor?: string;
}

// ── StorageDriver ──

export interface StorageDriver {
  /**
   * Create a new incident with packet and initial membership atomically.
   * If incident already exists (by incidentId), this is a no-op — use updatePacket instead.
   */
  createIncident(packet: IncidentPacket, membership: InitialMembership): Promise<void>;

  /**
   * Update only the packet for an existing incident.
   * Compact fields (telemetryScope, spanMembership, anomalousSignals, platformEvents) are preserved.
   * Used by rebuildSnapshots.
   */
  updatePacket(incidentId: string, packet: IncidentPacket): Promise<void>;

  updateIncidentStatus(id: string, status: "open" | "closed"): Promise<void>;

  appendDiagnosis(id: string, result: DiagnosisResult): Promise<void>;

  listIncidents(opts: { limit: number; cursor?: string }): Promise<IncidentPage>;

  getIncident(id: string): Promise<Incident | null>;

  getIncidentByPacketId(packetId: string): Promise<Incident | null>;

  /** Remove closed incidents where openedAt < before */
  deleteExpiredIncidents(before: Date): Promise<void>;

  /**
   * Monotonically expand the incident's telemetry scope.
   * windowStartMs: min(existing, expansion); windowEndMs: max(existing, expansion)
   * services: union of existing and expansion
   * Unknown incidentId is a no-op.
   */
  expandTelemetryScope(
    incidentId: string,
    expansion: { windowStartMs: number; windowEndMs: number; memberServices: string[]; dependencyServices: string[] },
  ): Promise<void>;

  /**
   * Append incident-bound span IDs ("traceId:spanId") to the membership set.
   * Dedup: duplicate IDs are silently ignored.
   * Capped at MAX_SPAN_MEMBERSHIP entries; oldest entries are dropped when exceeded.
   * Unknown incidentId is a no-op.
   */
  appendSpanMembership(incidentId: string, spanIds: string[]): Promise<void>;

  /**
   * Append anomalous signals to the incident.
   * Unknown incidentId is a no-op.
   */
  appendAnomalousSignals(incidentId: string, signals: AnomalousSignal[]): Promise<void>;

  /**
   * Append platform events to the incident.
   * Unknown incidentId is a no-op.
   */
  appendPlatformEvents(incidentId: string, events: PlatformEvent[]): Promise<void>;

  saveThinEvent(event: ThinEvent): Promise<void>;

  listThinEvents(): Promise<ThinEvent[]>;
}
