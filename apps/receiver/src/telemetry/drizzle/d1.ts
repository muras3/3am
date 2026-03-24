/**
 * D1TelemetryAdapter — TelemetryStoreDriver backed by Cloudflare D1 + Drizzle.
 *
 * Mechanical port of SQLiteTelemetryAdapter: same Drizzle schema (sqlite-core),
 * but uses drizzle-orm/d1 driver and async operations throughout.
 */
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { and, gte, lte, lt, inArray, eq, sql } from "drizzle-orm";
import type {
  TelemetryStoreDriver,
  TelemetrySpan,
  TelemetryMetric,
  TelemetryLog,
  TelemetryQueryFilter,
  SnapshotType,
  EvidenceSnapshot,
} from "../interface.js";
import {
  telemetrySpans,
  telemetryMetrics,
  telemetryLogs,
  incidentEvidenceSnapshots,
} from "./schema.js";

type Schema = {
  telemetrySpans: typeof telemetrySpans;
  telemetryMetrics: typeof telemetryMetrics;
  telemetryLogs: typeof telemetryLogs;
  incidentEvidenceSnapshots: typeof incidentEvidenceSnapshots;
};

export class D1TelemetryAdapter implements TelemetryStoreDriver {
  private db: DrizzleD1Database<Schema>;

  constructor(d1: D1Database) {
    this.db = drizzle(d1, {
      schema: { telemetrySpans, telemetryMetrics, telemetryLogs, incidentEvidenceSnapshots },
    });
  }

  /** Run inline DDL — async for D1. Call after construction. */
  async migrate(): Promise<void> {
    await this.db.run(sql`
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
        duration_ms      INTEGER NOT NULL,
        start_time_ms    INTEGER NOT NULL,
        peer_service     TEXT,
        exception_count  INTEGER NOT NULL,
        http_method      TEXT,
        span_kind        INTEGER,
        attributes       TEXT NOT NULL,
        ingested_at      INTEGER NOT NULL
      )
    `);
    await this.db.run(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_spans_trace_span
        ON telemetry_spans(trace_id, span_id)
    `);
    await this.db.run(sql`
      CREATE INDEX IF NOT EXISTS idx_spans_service_ingested
        ON telemetry_spans(service_name, ingested_at)
    `);

    await this.db.run(sql`
      CREATE TABLE IF NOT EXISTS telemetry_metrics (
        service       TEXT NOT NULL,
        environment   TEXT NOT NULL,
        name          TEXT NOT NULL,
        start_time_ms INTEGER NOT NULL,
        summary       TEXT NOT NULL,
        ingested_at   INTEGER NOT NULL
      )
    `);
    await this.db.run(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_metrics_service_name_time
        ON telemetry_metrics(service, name, start_time_ms)
    `);
    await this.db.run(sql`
      CREATE INDEX IF NOT EXISTS idx_metrics_ingested
        ON telemetry_metrics(ingested_at)
    `);

    await this.db.run(sql`
      CREATE TABLE IF NOT EXISTS telemetry_logs (
        service         TEXT NOT NULL,
        environment     TEXT NOT NULL,
        timestamp       TEXT NOT NULL,
        start_time_ms   INTEGER NOT NULL,
        severity        TEXT NOT NULL,
        severity_number INTEGER NOT NULL,
        body            TEXT NOT NULL,
        body_hash       TEXT NOT NULL,
        attributes      TEXT NOT NULL,
        trace_id        TEXT,
        span_id         TEXT,
        ingested_at     INTEGER NOT NULL
      )
    `);
    await this.db.run(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_logs_service_timestamp_hash
        ON telemetry_logs(service, timestamp, body_hash)
    `);
    await this.db.run(sql`
      CREATE INDEX IF NOT EXISTS idx_logs_ingested
        ON telemetry_logs(ingested_at)
    `);
    await this.db.run(sql`
      CREATE INDEX IF NOT EXISTS idx_logs_trace_id
        ON telemetry_logs(trace_id)
    `);

    await this.db.run(sql`
      CREATE TABLE IF NOT EXISTS incident_evidence_snapshots (
        incident_id   TEXT NOT NULL,
        snapshot_type  TEXT NOT NULL,
        data           TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      )
    `);
    await this.db.run(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_snapshots_incident_type
        ON incident_evidence_snapshots(incident_id, snapshot_type)
    `);
  }

  // ── Ingest ──────────────────────────────────────────────────────────────────

  async ingestSpans(rows: TelemetrySpan[]): Promise<void> {
    if (rows.length === 0) return;
    // D1 does not support interactive transactions — batch individual inserts
    for (const row of rows) {
      await this.db
        .insert(telemetrySpans)
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
          attributes: JSON.stringify(row.attributes),
          ingestedAt: row.ingestedAt,
        })
        .onConflictDoUpdate({
          target: [telemetrySpans.traceId, telemetrySpans.spanId],
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
            attributes: JSON.stringify(row.attributes),
            ingestedAt: row.ingestedAt,
          },
        });
    }
  }

  async ingestMetrics(rows: TelemetryMetric[]): Promise<void> {
    if (rows.length === 0) return;
    for (const row of rows) {
      await this.db
        .insert(telemetryMetrics)
        .values({
          service: row.service,
          environment: row.environment,
          name: row.name,
          startTimeMs: row.startTimeMs,
          summary: JSON.stringify(row.summary),
          ingestedAt: row.ingestedAt,
        })
        .onConflictDoUpdate({
          target: [telemetryMetrics.service, telemetryMetrics.name, telemetryMetrics.startTimeMs],
          set: {
            environment: row.environment,
            summary: JSON.stringify(row.summary),
            ingestedAt: row.ingestedAt,
          },
        });
    }
  }

  async ingestLogs(rows: TelemetryLog[]): Promise<void> {
    if (rows.length === 0) return;
    for (const row of rows) {
      await this.db
        .insert(telemetryLogs)
        .values({
          service: row.service,
          environment: row.environment,
          timestamp: row.timestamp,
          startTimeMs: row.startTimeMs,
          severity: row.severity,
          severityNumber: row.severityNumber,
          body: row.body,
          bodyHash: row.bodyHash,
          attributes: JSON.stringify(row.attributes),
          traceId: row.traceId ?? null,
          spanId: row.spanId ?? null,
          ingestedAt: row.ingestedAt,
        })
        .onConflictDoUpdate({
          target: [telemetryLogs.service, telemetryLogs.timestamp, telemetryLogs.bodyHash],
          set: {
            environment: row.environment,
            startTimeMs: row.startTimeMs,
            severity: row.severity,
            severityNumber: row.severityNumber,
            body: row.body,
            attributes: JSON.stringify(row.attributes),
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
      gte(telemetrySpans.startTimeMs, filter.startMs),
      lte(telemetrySpans.startTimeMs, filter.endMs),
    ];
    if (filter.services) {
      conditions.push(inArray(telemetrySpans.serviceName, filter.services));
    }
    if (filter.environment) {
      conditions.push(eq(telemetrySpans.environment, filter.environment));
    }

    const rows = await this.db
      .select()
      .from(telemetrySpans)
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
      attributes: JSON.parse(r.attributes) as Record<string, unknown>,
      ingestedAt: r.ingestedAt,
    }));
  }

  async queryMetrics(filter: TelemetryQueryFilter): Promise<TelemetryMetric[]> {
    const conditions = [
      gte(telemetryMetrics.startTimeMs, filter.startMs),
      lte(telemetryMetrics.startTimeMs, filter.endMs),
    ];
    if (filter.services) {
      conditions.push(inArray(telemetryMetrics.service, filter.services));
    }
    if (filter.environment) {
      conditions.push(eq(telemetryMetrics.environment, filter.environment));
    }

    const rows = await this.db
      .select()
      .from(telemetryMetrics)
      .where(and(...conditions));

    return rows.map((r) => ({
      service: r.service,
      environment: r.environment,
      name: r.name,
      startTimeMs: r.startTimeMs,
      summary: JSON.parse(r.summary) as Record<string, unknown>,
      ingestedAt: r.ingestedAt,
    }));
  }

  async queryLogs(filter: TelemetryQueryFilter): Promise<TelemetryLog[]> {
    const conditions = [
      gte(telemetryLogs.startTimeMs, filter.startMs),
      lte(telemetryLogs.startTimeMs, filter.endMs),
    ];
    if (filter.services) {
      conditions.push(inArray(telemetryLogs.service, filter.services));
    }
    if (filter.environment) {
      conditions.push(eq(telemetryLogs.environment, filter.environment));
    }

    const rows = await this.db
      .select()
      .from(telemetryLogs)
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
      attributes: JSON.parse(r.attributes) as Record<string, unknown>,
      ...(r.traceId != null ? { traceId: r.traceId } : {}),
      ...(r.spanId != null ? { spanId: r.spanId } : {}),
      ingestedAt: r.ingestedAt,
    }));
  }

  // ── Snapshots ───────────────────────────────────────────────────────────────

  async upsertSnapshot(incidentId: string, type: SnapshotType, data: unknown): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insert(incidentEvidenceSnapshots)
      .values({
        incidentId,
        snapshotType: type,
        data: JSON.stringify(data),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [incidentEvidenceSnapshots.incidentId, incidentEvidenceSnapshots.snapshotType],
        set: {
          data: JSON.stringify(data),
          updatedAt: now,
        },
      });
  }

  async getSnapshots(incidentId: string): Promise<EvidenceSnapshot[]> {
    const rows = await this.db
      .select()
      .from(incidentEvidenceSnapshots)
      .where(eq(incidentEvidenceSnapshots.incidentId, incidentId));

    return rows.map((r) => ({
      incidentId: r.incidentId,
      snapshotType: r.snapshotType as SnapshotType,
      data: JSON.parse(r.data),
      updatedAt: r.updatedAt,
    }));
  }

  async deleteSnapshots(incidentId: string): Promise<void> {
    await this.db
      .delete(incidentEvidenceSnapshots)
      .where(eq(incidentEvidenceSnapshots.incidentId, incidentId));
  }

  // ── TTL cleanup ─────────────────────────────────────────────────────────────

  async deleteExpired(before: Date): Promise<void> {
    const cutoff = before.getTime();
    await this.db.delete(telemetrySpans).where(lt(telemetrySpans.ingestedAt, cutoff));
    await this.db.delete(telemetryMetrics).where(lt(telemetryMetrics.ingestedAt, cutoff));
    await this.db.delete(telemetryLogs).where(lt(telemetryLogs.ingestedAt, cutoff));
  }
}
