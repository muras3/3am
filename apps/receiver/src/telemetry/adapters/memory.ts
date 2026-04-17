/**
 * MemoryTelemetryAdapter — TelemetryStoreDriver backed by in-memory Maps.
 *
 * Primary uses:
 *  - Unit / integration tests
 *  - Local development without persistent storage
 *
 * Dedup keys:
 *  - spans:   `${traceId}:${spanId}`
 *  - metrics: `${service}:${name}:${startTimeMs}`
 *  - logs:    `${service}:${timestamp}:${bodyHash}`
 *
 * UPSERT semantics: last write wins (Map.set).
 */
import {
  MAX_QUERY_LOGS,
  MAX_QUERY_METRICS,
  MAX_QUERY_SPANS,
  type TelemetryStoreDriver,
  type TelemetrySpan,
  type TelemetryMetric,
  type TelemetryLog,
  type TelemetryQueryFilter,
  type SnapshotType,
  type EvidenceSnapshot,
} from "../interface.js";

export class MemoryTelemetryAdapter implements TelemetryStoreDriver {
  private spans: Map<string, TelemetrySpan> = new Map();
  private metrics: Map<string, TelemetryMetric> = new Map();
  private logs: Map<string, TelemetryLog> = new Map();
  private snapshots: Map<string, Map<SnapshotType, EvidenceSnapshot>> = new Map();

  // ── Ingest ──────────────────────────────────────────────────────────────────

  async ingestSpans(rows: TelemetrySpan[]): Promise<void> {
    for (const row of rows) {
      const key = `${row.traceId}:${row.spanId}`;
      this.spans.set(key, row);
    }
  }

  async ingestMetrics(rows: TelemetryMetric[]): Promise<void> {
    for (const row of rows) {
      const key = `${row.service}:${row.name}:${row.startTimeMs}`;
      this.metrics.set(key, row);
    }
  }

  async ingestLogs(rows: TelemetryLog[]): Promise<void> {
    for (const row of rows) {
      const key = `${row.service}:${row.timestamp}:${row.bodyHash}`;
      this.logs.set(key, row);
    }
  }

  // ── Query ───────────────────────────────────────────────────────────────────

  async querySpans(filter: TelemetryQueryFilter): Promise<TelemetrySpan[]> {
    const result: TelemetrySpan[] = [];
    for (const span of this.spans.values()) {
      if (span.startTimeMs < filter.startMs || span.startTimeMs > filter.endMs) continue;
      if (filter.services && !filter.services.includes(span.serviceName)) continue;
      if (filter.environment && span.environment !== filter.environment) continue;
      result.push(span);
    }
    const order = filter.orderBy ?? "startTimeDesc";
    result.sort((a, b) => order === "startTimeAsc" ? a.startTimeMs - b.startTimeMs : b.startTimeMs - a.startTimeMs);
    return result.slice(0, Math.min(filter.limit ?? MAX_QUERY_SPANS, MAX_QUERY_SPANS));
  }

  async queryMetrics(filter: TelemetryQueryFilter): Promise<TelemetryMetric[]> {
    const result: TelemetryMetric[] = [];
    for (const metric of this.metrics.values()) {
      if (metric.startTimeMs < filter.startMs || metric.startTimeMs > filter.endMs) continue;
      if (filter.services && !filter.services.includes(metric.service)) continue;
      if (filter.environment && metric.environment !== filter.environment) continue;
      result.push(metric);
    }
    const order = filter.orderBy ?? "startTimeDesc";
    result.sort((a, b) => order === "startTimeAsc" ? a.startTimeMs - b.startTimeMs : b.startTimeMs - a.startTimeMs);
    return result.slice(0, Math.min(filter.limit ?? MAX_QUERY_METRICS, MAX_QUERY_METRICS));
  }

  async queryLogs(filter: TelemetryQueryFilter): Promise<TelemetryLog[]> {
    const result: TelemetryLog[] = [];
    for (const log of this.logs.values()) {
      if (log.startTimeMs < filter.startMs || log.startTimeMs > filter.endMs) continue;
      if (filter.services && !filter.services.includes(log.service)) continue;
      if (filter.environment && log.environment !== filter.environment) continue;
      result.push(log);
    }
    const order = filter.orderBy ?? "startTimeDesc";
    result.sort((a, b) => order === "startTimeAsc" ? a.startTimeMs - b.startTimeMs : b.startTimeMs - a.startTimeMs);
    return result.slice(0, Math.min(filter.limit ?? MAX_QUERY_LOGS, MAX_QUERY_LOGS));
  }

  // ── Snapshots ───────────────────────────────────────────────────────────────

  async upsertSnapshot(incidentId: string, type: SnapshotType, data: unknown): Promise<void> {
    let incidentSnapshots = this.snapshots.get(incidentId);
    if (!incidentSnapshots) {
      incidentSnapshots = new Map();
      this.snapshots.set(incidentId, incidentSnapshots);
    }
    incidentSnapshots.set(type, {
      incidentId,
      snapshotType: type,
      data,
      updatedAt: new Date().toISOString(),
    });
  }

  async getSnapshots(incidentId: string): Promise<EvidenceSnapshot[]> {
    const incidentSnapshots = this.snapshots.get(incidentId);
    if (!incidentSnapshots) return [];
    return Array.from(incidentSnapshots.values());
  }

  async deleteSnapshots(incidentId: string): Promise<void> {
    this.snapshots.delete(incidentId);
  }

  // ── TTL cleanup ─────────────────────────────────────────────────────────────

  async deleteExpired(before: Date): Promise<void> {
    const cutoff = before.getTime();
    for (const [key, span] of this.spans) {
      if (span.ingestedAt < cutoff) this.spans.delete(key);
    }
    for (const [key, metric] of this.metrics) {
      if (metric.ingestedAt < cutoff) this.metrics.delete(key);
    }
    for (const [key, log] of this.logs) {
      if (log.ingestedAt < cutoff) this.logs.delete(key);
    }
  }

  async deleteExpiredSnapshots(before: Date): Promise<void> {
    const cutoffIso = before.toISOString();
    for (const [incidentId, typeMap] of this.snapshots) {
      for (const [type, snapshot] of typeMap) {
        if (snapshot.updatedAt < cutoffIso) typeMap.delete(type);
      }
      if (typeMap.size === 0) this.snapshots.delete(incidentId);
    }
  }
}
