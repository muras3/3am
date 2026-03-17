/**
 * TelemetryStore — unified OTel data storage types and driver interface.
 *
 * ADR 0032 Appendix A.1: Row types are DB-column 1:1 representations,
 * separate from existing ExtractedSpan / ChangedMetric / RelevantLog.
 * The packetizer is responsible for converting TelemetryStore rows
 * to packet format.
 */

// ── Row Types (DB column 1:1) ────────────────────────────────────────────

export interface TelemetrySpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  serviceName: string
  environment: string
  spanName: string
  httpRoute?: string
  httpStatusCode?: number
  spanStatusCode: number
  durationMs: number
  startTimeMs: number
  peerService?: string
  exceptionCount: number
  attributes: Record<string, unknown>  // JSONB/TEXT
  ingestedAt: number                   // epoch ms
}

export interface TelemetryMetric {
  service: string
  environment: string
  name: string
  startTimeMs: number
  summary: Record<string, unknown>     // JSONB/TEXT
  ingestedAt: number                   // epoch ms
}

export interface TelemetryLog {
  service: string
  environment: string
  timestamp: string                    // ISO string
  startTimeMs: number
  severity: string                     // WARN | ERROR | FATAL
  severityNumber: number
  body: string
  bodyHash: string                     // normalized SHA-256 hex, 16 chars
  attributes: Record<string, unknown>  // JSONB/TEXT
  traceId?: string
  spanId?: string
  ingestedAt: number                   // epoch ms
}

// ── Query Filter ─────────────────────────────────────────────────────────

export interface TelemetryQueryFilter {
  startMs: number   // inclusive
  endMs: number     // inclusive
  services?: string[]  // omit = all services
  environment?: string
}

// ── Evidence Snapshot ────────────────────────────────────────────────────

export type SnapshotType = 'traces' | 'metrics' | 'logs'

export interface EvidenceSnapshot {
  incidentId: string
  snapshotType: SnapshotType
  data: unknown    // JSONB: selected RepresentativeTrace[] | ChangedMetric[] | RelevantLog[]
  updatedAt: string
}

// ── Driver Interface ─────────────────────────────────────────────────────

export interface TelemetryStoreDriver {
  // Ingest (UPSERT dedup)
  ingestSpans(rows: TelemetrySpan[]): Promise<void>
  ingestMetrics(rows: TelemetryMetric[]): Promise<void>
  ingestLogs(rows: TelemetryLog[]): Promise<void>

  // Query (time window + services)
  querySpans(filter: TelemetryQueryFilter): Promise<TelemetrySpan[]>
  queryMetrics(filter: TelemetryQueryFilter): Promise<TelemetryMetric[]>
  queryLogs(filter: TelemetryQueryFilter): Promise<TelemetryLog[]>

  // Evidence Snapshots (curated selection per incident)
  upsertSnapshot(incidentId: string, type: SnapshotType, data: unknown): Promise<void>
  getSnapshots(incidentId: string): Promise<EvidenceSnapshot[]>
  deleteSnapshots(incidentId: string): Promise<void>

  // TTL cleanup
  deleteExpired(before: Date): Promise<void>
}
