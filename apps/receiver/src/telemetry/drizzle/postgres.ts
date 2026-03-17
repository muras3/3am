/**
 * PostgresTelemetryAdapter — TelemetryStoreDriver backed by postgres.js + Drizzle.
 *
 * Requires DATABASE_URL env var (postgres://user:pass@host:port/dbname).
 * Used for Vercel Postgres in production and Docker Postgres in development / CI.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { and, gte, lte, lt, inArray, eq, sql as drizzleSql } from "drizzle-orm";
import { pgTable, text, integer, bigint, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import type {
  TelemetryStoreDriver,
  TelemetrySpan,
  TelemetryMetric,
  TelemetryLog,
  TelemetryQueryFilter,
  SnapshotType,
  EvidenceSnapshot,
} from "../interface.js";

// ── Postgres-specific table definitions (JSONB, bigint as integer) ───────────

const pgTelemetrySpans = pgTable("telemetry_spans", {
  traceId: text("trace_id").notNull(),
  spanId: text("span_id").notNull(),
  parentSpanId: text("parent_span_id"),
  serviceName: text("service_name").notNull(),
  environment: text("environment").notNull(),
  spanName: text("span_name").notNull(),
  httpRoute: text("http_route"),
  httpStatusCode: integer("http_status_code"),
  spanStatusCode: integer("span_status_code").notNull(),
  durationMs: bigint("duration_ms", { mode: "number" }).notNull(),
  startTimeMs: bigint("start_time_ms", { mode: "number" }).notNull(),
  peerService: text("peer_service"),
  exceptionCount: integer("exception_count").notNull(),
  httpMethod: text("http_method"),
  spanKind: integer("span_kind"),
  attributes: jsonb("attributes").notNull(),
  ingestedAt: bigint("ingested_at", { mode: "number" }).notNull(), // epoch ms
}, (table) => [
  uniqueIndex("uq_pg_spans_trace_span").on(table.traceId, table.spanId),
  index("idx_pg_spans_service_ingested").on(table.serviceName, table.ingestedAt),
]);

const pgTelemetryMetrics = pgTable("telemetry_metrics", {
  service: text("service").notNull(),
  environment: text("environment").notNull(),
  name: text("name").notNull(),
  startTimeMs: bigint("start_time_ms", { mode: "number" }).notNull(),
  summary: jsonb("summary").notNull(),
  ingestedAt: bigint("ingested_at", { mode: "number" }).notNull(),
}, (table) => [
  uniqueIndex("uq_pg_metrics_service_name_time").on(table.service, table.name, table.startTimeMs),
  index("idx_pg_metrics_ingested").on(table.ingestedAt),
]);

const pgTelemetryLogs = pgTable("telemetry_logs", {
  service: text("service").notNull(),
  environment: text("environment").notNull(),
  timestamp: text("timestamp").notNull(),
  startTimeMs: bigint("start_time_ms", { mode: "number" }).notNull(),
  severity: text("severity").notNull(),
  severityNumber: integer("severity_number").notNull(),
  body: text("body").notNull(),
  bodyHash: text("body_hash").notNull(),
  attributes: jsonb("attributes").notNull(),
  traceId: text("trace_id"),
  spanId: text("span_id"),
  ingestedAt: bigint("ingested_at", { mode: "number" }).notNull(),
}, (table) => [
  uniqueIndex("uq_pg_logs_service_timestamp_hash").on(table.service, table.timestamp, table.bodyHash),
  index("idx_pg_logs_ingested").on(table.ingestedAt),
  index("idx_pg_logs_trace_id").on(table.traceId),
]);

const pgIncidentEvidenceSnapshots = pgTable("incident_evidence_snapshots", {
  incidentId: text("incident_id").notNull(),
  snapshotType: text("snapshot_type").notNull(),
  data: jsonb("data").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("uq_pg_snapshots_incident_type").on(table.incidentId, table.snapshotType),
]);

type PgSchema = {
  pgTelemetrySpans: typeof pgTelemetrySpans;
  pgTelemetryMetrics: typeof pgTelemetryMetrics;
  pgTelemetryLogs: typeof pgTelemetryLogs;
  pgIncidentEvidenceSnapshots: typeof pgIncidentEvidenceSnapshots;
};

export class PostgresTelemetryAdapter implements TelemetryStoreDriver {
  private db: PostgresJsDatabase<PgSchema>;
  private client: ReturnType<typeof postgres>;

  constructor(connectionString?: string) {
    const url = connectionString ?? process.env["DATABASE_URL"];
    if (!url) throw new Error("DATABASE_URL is required for PostgresTelemetryAdapter");
    this.client = postgres(url, { max: 10 });
    this.db = drizzle(this.client, {
      schema: { pgTelemetrySpans, pgTelemetryMetrics, pgTelemetryLogs, pgIncidentEvidenceSnapshots },
    });
  }

  /** Run DDL to create tables if they don't exist. Call once at startup. */
  async migrate(): Promise<void> {
    await this.db.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS telemetry_spans (
        trace_id         TEXT NOT NULL,
        span_id          TEXT NOT NULL,
        parent_span_id   TEXT,
        service_name     TEXT NOT NULL,
        environment      TEXT NOT NULL,
        span_name        TEXT NOT NULL,
        http_route       TEXT,
        http_status_code INTEGER,
        span_status_code INTEGER NOT NULL,
        duration_ms      BIGINT NOT NULL,
        start_time_ms    BIGINT NOT NULL,
        peer_service     TEXT,
        exception_count  INTEGER NOT NULL,
        http_method      TEXT,
        span_kind        INTEGER,
        attributes       JSONB NOT NULL,
        ingested_at      BIGINT NOT NULL
      )
    `);
    // Add columns if not present (migration for existing deployments)
    await this.db.execute(drizzleSql`
      ALTER TABLE telemetry_spans ADD COLUMN IF NOT EXISTS http_method TEXT
    `);
    await this.db.execute(drizzleSql`
      ALTER TABLE telemetry_spans ADD COLUMN IF NOT EXISTS span_kind INTEGER
    `);
    await this.db.execute(drizzleSql`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_pg_spans_trace_span
        ON telemetry_spans(trace_id, span_id)
    `);
    await this.db.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS idx_pg_spans_service_ingested
        ON telemetry_spans(service_name, ingested_at)
    `);

    await this.db.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS telemetry_metrics (
        service       TEXT NOT NULL,
        environment   TEXT NOT NULL,
        name          TEXT NOT NULL,
        start_time_ms BIGINT NOT NULL,
        summary       JSONB NOT NULL,
        ingested_at   BIGINT NOT NULL
      )
    `);
    await this.db.execute(drizzleSql`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_pg_metrics_service_name_time
        ON telemetry_metrics(service, name, start_time_ms)
    `);
    await this.db.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS idx_pg_metrics_ingested
        ON telemetry_metrics(ingested_at)
    `);

    await this.db.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS telemetry_logs (
        service         TEXT NOT NULL,
        environment     TEXT NOT NULL,
        timestamp       TEXT NOT NULL,
        start_time_ms   BIGINT NOT NULL,
        severity        TEXT NOT NULL,
        severity_number INTEGER NOT NULL,
        body            TEXT NOT NULL,
        body_hash       TEXT NOT NULL,
        attributes      JSONB NOT NULL,
        trace_id        TEXT,
        span_id         TEXT,
        ingested_at     BIGINT NOT NULL
      )
    `);
    await this.db.execute(drizzleSql`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_pg_logs_service_timestamp_hash
        ON telemetry_logs(service, timestamp, body_hash)
    `);
    await this.db.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS idx_pg_logs_ingested
        ON telemetry_logs(ingested_at)
    `);
    await this.db.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS idx_pg_logs_trace_id
        ON telemetry_logs(trace_id)
    `);

    await this.db.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS incident_evidence_snapshots (
        incident_id   TEXT NOT NULL,
        snapshot_type  TEXT NOT NULL,
        data           JSONB NOT NULL,
        updated_at     TEXT NOT NULL
      )
    `);
    await this.db.execute(drizzleSql`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_pg_snapshots_incident_type
        ON incident_evidence_snapshots(incident_id, snapshot_type)
    `);
  }

  /** Expose raw SQL execution for tests (e.g. TRUNCATE). */
  async execute(query: Parameters<typeof this.db.execute>[0]): Promise<void> {
    await this.db.execute(query);
  }

  /** Close the underlying postgres.js connection pool. */
  async close(): Promise<void> {
    await this.client.end();
  }

  // ── Ingest ──────────────────────────────────────────────────────────────────

  async ingestSpans(rows: TelemetrySpan[]): Promise<void> {
    if (rows.length === 0) return;
    for (const row of rows) {
      await this.db
        .insert(pgTelemetrySpans)
        .values({
          traceId: row.traceId,
          spanId: row.spanId,
          parentSpanId: row.parentSpanId ?? null,
          serviceName: row.serviceName,
          environment: row.environment,
          spanName: row.spanName,
          httpRoute: row.httpRoute ?? null,
          httpStatusCode: row.httpStatusCode ?? null,
          spanStatusCode: row.spanStatusCode,
          durationMs: row.durationMs,
          startTimeMs: row.startTimeMs,
          peerService: row.peerService ?? null,
          exceptionCount: row.exceptionCount,
          httpMethod: row.httpMethod ?? null,
          spanKind: row.spanKind ?? null,
          attributes: row.attributes,
          ingestedAt: row.ingestedAt,
        })
        .onConflictDoUpdate({
          target: [pgTelemetrySpans.traceId, pgTelemetrySpans.spanId],
          set: {
            parentSpanId: row.parentSpanId ?? null,
            serviceName: row.serviceName,
            environment: row.environment,
            spanName: row.spanName,
            httpRoute: row.httpRoute ?? null,
            httpStatusCode: row.httpStatusCode ?? null,
            spanStatusCode: row.spanStatusCode,
            durationMs: row.durationMs,
            startTimeMs: row.startTimeMs,
            peerService: row.peerService ?? null,
            exceptionCount: row.exceptionCount,
            httpMethod: row.httpMethod ?? null,
            spanKind: row.spanKind ?? null,
            attributes: row.attributes,
            ingestedAt: row.ingestedAt,
          },
        });
    }
  }

  async ingestMetrics(rows: TelemetryMetric[]): Promise<void> {
    if (rows.length === 0) return;
    for (const row of rows) {
      await this.db
        .insert(pgTelemetryMetrics)
        .values({
          service: row.service,
          environment: row.environment,
          name: row.name,
          startTimeMs: row.startTimeMs,
          summary: row.summary,
          ingestedAt: row.ingestedAt,
        })
        .onConflictDoUpdate({
          target: [pgTelemetryMetrics.service, pgTelemetryMetrics.name, pgTelemetryMetrics.startTimeMs],
          set: {
            environment: row.environment,
            summary: row.summary,
            ingestedAt: row.ingestedAt,
          },
        });
    }
  }

  async ingestLogs(rows: TelemetryLog[]): Promise<void> {
    if (rows.length === 0) return;
    for (const row of rows) {
      await this.db
        .insert(pgTelemetryLogs)
        .values({
          service: row.service,
          environment: row.environment,
          timestamp: row.timestamp,
          startTimeMs: row.startTimeMs,
          severity: row.severity,
          severityNumber: row.severityNumber,
          body: row.body,
          bodyHash: row.bodyHash,
          attributes: row.attributes,
          traceId: row.traceId ?? null,
          spanId: row.spanId ?? null,
          ingestedAt: row.ingestedAt,
        })
        .onConflictDoUpdate({
          target: [pgTelemetryLogs.service, pgTelemetryLogs.timestamp, pgTelemetryLogs.bodyHash],
          set: {
            environment: row.environment,
            startTimeMs: row.startTimeMs,
            severity: row.severity,
            severityNumber: row.severityNumber,
            body: row.body,
            attributes: row.attributes,
            traceId: row.traceId ?? null,
            spanId: row.spanId ?? null,
            ingestedAt: row.ingestedAt,
          },
        });
    }
  }

  // ── Query ───────────────────────────────────────────────────────────────────

  async querySpans(filter: TelemetryQueryFilter): Promise<TelemetrySpan[]> {
    const conditions = [
      gte(pgTelemetrySpans.startTimeMs, filter.startMs),
      lte(pgTelemetrySpans.startTimeMs, filter.endMs),
    ];
    if (filter.services) {
      conditions.push(inArray(pgTelemetrySpans.serviceName, filter.services));
    }
    if (filter.environment) {
      conditions.push(eq(pgTelemetrySpans.environment, filter.environment));
    }

    const rows = await this.db
      .select()
      .from(pgTelemetrySpans)
      .where(and(...conditions));

    return rows.map((r) => ({
      traceId: r.traceId,
      spanId: r.spanId,
      ...(r.parentSpanId != null ? { parentSpanId: r.parentSpanId } : {}),
      serviceName: r.serviceName,
      environment: r.environment,
      spanName: r.spanName,
      ...(r.httpRoute != null ? { httpRoute: r.httpRoute } : {}),
      ...(r.httpStatusCode != null ? { httpStatusCode: r.httpStatusCode } : {}),
      spanStatusCode: r.spanStatusCode,
      durationMs: r.durationMs,
      startTimeMs: r.startTimeMs,
      ...(r.peerService != null ? { peerService: r.peerService } : {}),
      exceptionCount: r.exceptionCount,
      ...(r.httpMethod != null ? { httpMethod: r.httpMethod } : {}),
      ...(r.spanKind != null ? { spanKind: r.spanKind } : {}),
      attributes: r.attributes as Record<string, unknown>,
      ingestedAt: r.ingestedAt,
    }));
  }

  async queryMetrics(filter: TelemetryQueryFilter): Promise<TelemetryMetric[]> {
    const conditions = [
      gte(pgTelemetryMetrics.startTimeMs, filter.startMs),
      lte(pgTelemetryMetrics.startTimeMs, filter.endMs),
    ];
    if (filter.services) {
      conditions.push(inArray(pgTelemetryMetrics.service, filter.services));
    }
    if (filter.environment) {
      conditions.push(eq(pgTelemetryMetrics.environment, filter.environment));
    }

    const rows = await this.db
      .select()
      .from(pgTelemetryMetrics)
      .where(and(...conditions));

    return rows.map((r) => ({
      service: r.service,
      environment: r.environment,
      name: r.name,
      startTimeMs: r.startTimeMs,
      summary: r.summary as Record<string, unknown>,
      ingestedAt: r.ingestedAt,
    }));
  }

  async queryLogs(filter: TelemetryQueryFilter): Promise<TelemetryLog[]> {
    const conditions = [
      gte(pgTelemetryLogs.startTimeMs, filter.startMs),
      lte(pgTelemetryLogs.startTimeMs, filter.endMs),
    ];
    if (filter.services) {
      conditions.push(inArray(pgTelemetryLogs.service, filter.services));
    }
    if (filter.environment) {
      conditions.push(eq(pgTelemetryLogs.environment, filter.environment));
    }

    const rows = await this.db
      .select()
      .from(pgTelemetryLogs)
      .where(and(...conditions));

    return rows.map((r) => ({
      service: r.service,
      environment: r.environment,
      timestamp: r.timestamp,
      startTimeMs: r.startTimeMs,
      severity: r.severity,
      severityNumber: r.severityNumber,
      body: r.body,
      bodyHash: r.bodyHash,
      attributes: r.attributes as Record<string, unknown>,
      ...(r.traceId != null ? { traceId: r.traceId } : {}),
      ...(r.spanId != null ? { spanId: r.spanId } : {}),
      ingestedAt: r.ingestedAt,
    }));
  }

  // ── Snapshots ───────────────────────────────────────────────────────────────

  async upsertSnapshot(incidentId: string, type: SnapshotType, data: unknown): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insert(pgIncidentEvidenceSnapshots)
      .values({
        incidentId,
        snapshotType: type,
        data,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [pgIncidentEvidenceSnapshots.incidentId, pgIncidentEvidenceSnapshots.snapshotType],
        set: {
          data,
          updatedAt: now,
        },
      });
  }

  async getSnapshots(incidentId: string): Promise<EvidenceSnapshot[]> {
    const rows = await this.db
      .select()
      .from(pgIncidentEvidenceSnapshots)
      .where(eq(pgIncidentEvidenceSnapshots.incidentId, incidentId));

    return rows.map((r) => ({
      incidentId: r.incidentId,
      snapshotType: r.snapshotType as SnapshotType,
      data: r.data,
      updatedAt: r.updatedAt,
    }));
  }

  async deleteSnapshots(incidentId: string): Promise<void> {
    await this.db
      .delete(pgIncidentEvidenceSnapshots)
      .where(eq(pgIncidentEvidenceSnapshots.incidentId, incidentId));
  }

  // ── TTL cleanup ─────────────────────────────────────────────────────────────

  async deleteExpired(before: Date): Promise<void> {
    const cutoff = before.getTime();
    await this.db.delete(pgTelemetrySpans).where(lt(pgTelemetrySpans.ingestedAt, cutoff));
    await this.db.delete(pgTelemetryMetrics).where(lt(pgTelemetryMetrics.ingestedAt, cutoff));
    await this.db.delete(pgTelemetryLogs).where(lt(pgTelemetryLogs.ingestedAt, cutoff));
  }
}
