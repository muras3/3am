import type { IncidentPacket, DiagnosisResult, ConsoleNarrative, PlatformEvent, ThinEvent } from "3am-core";

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

/**
 * Maximum number of anomalous signal entries per incident.
 * Each entry is ~100 bytes in JSON. 1000 entries ≈ ~100 KB.
 * When exceeded, the oldest entries (earliest in the array) are dropped.
 */
export const MAX_ANOMALOUS_SIGNALS = 1_000;

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
  lastActivityAt: string;
  packet: IncidentPacket;
  diagnosisResult?: DiagnosisResult;
  consoleNarrative?: ConsoleNarrative;
  diagnosisScheduledAt?: string;       // ISO timestamp — set when diagnosis is enqueued/scheduled
  diagnosisDispatchedAt?: string;     // ISO timestamp — set when diagnosis dispatch is claimed
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
   * Return the next monotonic incident sequence number.
   * Used to generate human-friendly incident IDs such as inc_000001.
   */
  nextIncidentSequence(): Promise<number>;

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

  touchIncidentActivity(id: string, at?: string): Promise<void>;

  appendDiagnosis(id: string, result: DiagnosisResult): Promise<void>;

  appendConsoleNarrative(id: string, narrative: ConsoleNarrative): Promise<void>;

  listIncidents(opts: { limit: number; cursor?: string }): Promise<IncidentPage>;

  getIncident(id: string): Promise<Incident | null>;

  getIncidentByPacketId(packetId: string): Promise<Incident | null>;

  /** Remove closed incidents where closedAt < before */
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
   * #256: Combined expand scope + append membership + append signals in one read-modify-write.
   * Reduces D1 round-trips from 6 (3 reads + 3 writes) to 2 (1 read + 1 write).
   * Falls back to calling the three individual methods if not overridden.
   */
  expandAndAppend?(
    incidentId: string,
    expansion: { windowStartMs: number; windowEndMs: number; memberServices: string[]; dependencyServices: string[]; spanIds: string[] },
    signals: AnomalousSignal[],
  ): Promise<void>;

  /**
   * Append platform events to the incident.
   * Unknown incidentId is a no-op.
   */
  appendPlatformEvents(incidentId: string, events: PlatformEvent[]): Promise<void>;

  /**
   * Atomically claim diagnosis dispatch for an incident.
   * Returns true if this call won the claim (diagnosis should proceed).
   * Returns false if another instance already claimed (skip diagnosis).
   * Uses optimistic locking with a lease: UPDATE ... WHERE diagnosis_dispatched_at IS NULL OR expired.
   */
  claimDiagnosisDispatch(incidentId: string, leaseMs?: number): Promise<boolean>;

  /**
   * Release a previously claimed diagnosis dispatch.
   * Sets diagnosis_dispatched_at back to NULL so the incident can be retried.
   * Used when diagnosis fails after claiming dispatch.
   */
  releaseDiagnosisDispatch(incidentId: string): Promise<void>;

  /**
   * Atomically claim materialization lease for an incident.
   * Prevents duplicate concurrent rebuildSnapshots calls.
   * Returns true if this call won the claim (rebuild should proceed).
   * Returns false if another reader already claimed (skip rebuild).
   */
  claimMaterializationLease(incidentId: string, leaseMs?: number): Promise<boolean>;

  /**
   * Release a previously claimed materialization lease.
   * Sets materialization_claimed_at back to NULL.
   */
  releaseMaterializationLease(incidentId: string): Promise<void>;

  /**
   * Mark that a diagnosis has been scheduled/enqueued for an incident.
   * Only sets the timestamp if diagnosisScheduledAt is not already set (idempotent).
   * Used to distinguish "pending" from "unavailable" in the diagnosis state machine.
   */
  markDiagnosisScheduled(incidentId: string, at?: string): Promise<void>;

  /**
   * Clear the diagnosisScheduledAt marker.
   * Used when diagnosis completes or is no longer expected.
   */
  clearDiagnosisScheduled(incidentId: string): Promise<void>;

  saveThinEvent(event: ThinEvent): Promise<void>;

  listThinEvents(): Promise<ThinEvent[]>;

  /**
   * Get a settings value by key.
   * Returns null if not found.
   */
  getSettings(key: string): Promise<string | null>;

  /**
   * Set a settings value by key.
   */
  setSettings(key: string, value: string): Promise<void>;

  /**
   * Atomically consume one request from a shared rate-limit bucket.
   * Returns true when the request is allowed, false when the bucket is exhausted.
   */
  consumeRateLimit(key: string, windowMs: number, max: number, now?: number): Promise<boolean>;
}
