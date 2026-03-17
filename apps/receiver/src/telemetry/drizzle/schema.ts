/**
 * Drizzle schema — SQLite telemetry tables (used by SQLiteTelemetryAdapter).
 *
 * PostgresTelemetryAdapter defines its own PG-specific schema inline using pgTable/jsonb.
 * SQLite stores attributes, summary, and snapshot data as JSON text strings.
 */
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

// ── telemetry_spans ─────────────────────────────────────────────────────────

export const telemetrySpans = sqliteTable("telemetry_spans", {
  traceId: text("trace_id").notNull(),
  spanId: text("span_id").notNull(),
  parentSpanId: text("parent_span_id"),
  serviceName: text("service_name").notNull(),
  environment: text("environment").notNull(),
  spanName: text("span_name").notNull(),
  httpRoute: text("http_route"),
  httpStatusCode: integer("http_status_code"),
  spanStatusCode: integer("span_status_code").notNull(),
  durationMs: integer("duration_ms").notNull(),
  startTimeMs: integer("start_time_ms").notNull(),
  peerService: text("peer_service"),
  exceptionCount: integer("exception_count").notNull(),
  attributes: text("attributes").notNull(),   // JSON string
  ingestedAt: integer("ingested_at").notNull(), // epoch ms
}, (table) => [
  uniqueIndex("uq_spans_trace_span").on(table.traceId, table.spanId),
  index("idx_spans_service_ingested").on(table.serviceName, table.ingestedAt),
]);

// ── telemetry_metrics ───────────────────────────────────────────────────────

export const telemetryMetrics = sqliteTable("telemetry_metrics", {
  service: text("service").notNull(),
  environment: text("environment").notNull(),
  name: text("name").notNull(),
  startTimeMs: integer("start_time_ms").notNull(),
  summary: text("summary").notNull(),         // JSON string
  ingestedAt: integer("ingested_at").notNull(), // epoch ms
}, (table) => [
  uniqueIndex("uq_metrics_service_name_time").on(table.service, table.name, table.startTimeMs),
  index("idx_metrics_ingested").on(table.ingestedAt),
]);

// ── telemetry_logs ──────────────────────────────────────────────────────────

export const telemetryLogs = sqliteTable("telemetry_logs", {
  service: text("service").notNull(),
  environment: text("environment").notNull(),
  timestamp: text("timestamp").notNull(),      // ISO string
  startTimeMs: integer("start_time_ms").notNull(),
  severity: text("severity").notNull(),
  severityNumber: integer("severity_number").notNull(),
  body: text("body").notNull(),
  bodyHash: text("body_hash").notNull(),       // normalized SHA-256 hex, 16 chars
  attributes: text("attributes").notNull(),    // JSON string
  traceId: text("trace_id"),
  spanId: text("span_id"),
  ingestedAt: integer("ingested_at").notNull(), // epoch ms
}, (table) => [
  uniqueIndex("uq_logs_service_timestamp_hash").on(table.service, table.timestamp, table.bodyHash),
  index("idx_logs_ingested").on(table.ingestedAt),
  index("idx_logs_trace_id").on(table.traceId),
]);

// ── incident_evidence_snapshots ─────────────────────────────────────────────

export const incidentEvidenceSnapshots = sqliteTable("incident_evidence_snapshots", {
  incidentId: text("incident_id").notNull(),
  snapshotType: text("snapshot_type").notNull(), // 'traces' | 'metrics' | 'logs'
  data: text("data").notNull(),                  // JSON string
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("uq_snapshots_incident_type").on(table.incidentId, table.snapshotType),
]);

export type TelemetrySpansTable = typeof telemetrySpans;
export type TelemetryMetricsTable = typeof telemetryMetrics;
export type TelemetryLogsTable = typeof telemetryLogs;
export type IncidentEvidenceSnapshotsTable = typeof incidentEvidenceSnapshots;
