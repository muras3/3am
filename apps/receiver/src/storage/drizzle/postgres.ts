/**
 * PostgresAdapter — StorageDriver backed by postgres.js + Drizzle.
 *
 * Requires DATABASE_URL env var (postgres://user:pass@host:port/dbname).
 * Used for Vercel Postgres in production and Docker Postgres in development / CI.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { eq, desc, lt, and, sql as drizzleSql, count } from "drizzle-orm";
import { pgTable, text, timestamp, serial, jsonb } from "drizzle-orm/pg-core";
import type { IncidentPacket, DiagnosisResult, PlatformEvent, ThinEvent, ChangedMetric, RelevantLog } from "@3amoncall/core";
import type { ExtractedSpan } from "../../domain/anomaly-detector.js";
import type { AnomalousSignal, Incident, IncidentPage, IncidentRawState, StorageDriver } from "../interface.js";
import { createEmptyRawState } from "../interface.js";

// ── Postgres-specific table definitions (JSONB, timestamptz) ─────────────────

const pgIncidents = pgTable("incidents", {
  incidentId: text("incident_id").primaryKey(),
  status: text("status", { enum: ["open", "closed"] as const }).notNull().default("open"),
  openedAt: text("opened_at").notNull(),
  closedAt: text("closed_at"),
  packet: jsonb("packet").notNull(),
  diagnosisResult: jsonb("diagnosis_result"),
  rawState: jsonb("raw_state"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

const pgThinEvents = pgTable("thin_events", {
  id: serial("id").primaryKey(),
  eventId: text("event_id").notNull().unique(),
  eventType: text("event_type").notNull(),
  incidentId: text("incident_id").notNull(),
  packetId: text("packet_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

type PgSchema = { pgIncidents: typeof pgIncidents; pgThinEvents: typeof pgThinEvents };

export class PostgresAdapter implements StorageDriver {
  private db: PostgresJsDatabase<PgSchema>;
  private client: ReturnType<typeof postgres>;

  constructor(connectionString?: string) {
    const url = connectionString ?? process.env["DATABASE_URL"];
    if (!url) throw new Error("DATABASE_URL is required for PostgresAdapter");
    this.client = postgres(url, { max: 10 });
    this.db = drizzle(this.client, { schema: { pgIncidents, pgThinEvents } });
  }

  /** Run DDL to create tables if they don't exist. Call once at startup. */
  async migrate(): Promise<void> {
    await this.db.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS incidents (
        incident_id      TEXT PRIMARY KEY,
        status           TEXT NOT NULL DEFAULT 'open',
        opened_at        TEXT NOT NULL,
        closed_at        TEXT,
        packet           JSONB NOT NULL,
        diagnosis_result JSONB,
        raw_state        JSONB,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.db.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS thin_events (
        id          SERIAL PRIMARY KEY,
        event_id    TEXT NOT NULL UNIQUE,
        event_type  TEXT NOT NULL,
        incident_id TEXT NOT NULL,
        packet_id   TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.db.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS idx_incidents_opened_at ON incidents(opened_at DESC)
    `);
    await this.db.execute(drizzleSql`
      CREATE INDEX IF NOT EXISTS idx_incidents_packet_id ON incidents((packet->>'packetId'))
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

  private toIncident(row: typeof pgIncidents.$inferSelect): Incident {
    const incident: Incident = {
      incidentId: row.incidentId,
      status: row.status as "open" | "closed",
      openedAt: row.openedAt,
      packet: row.packet as IncidentPacket,
      rawState: row.rawState ? (row.rawState as IncidentRawState) : createEmptyRawState(),
    };
    if (row.closedAt) incident.closedAt = row.closedAt;
    if (row.diagnosisResult) {
      incident.diagnosisResult = row.diagnosisResult as DiagnosisResult;
    }
    return incident;
  }

  async createIncident(packet: IncidentPacket): Promise<void> {
    await this.db
      .insert(pgIncidents)
      .values({
        incidentId: packet.incidentId,
        status: "open",
        openedAt: packet.openedAt,
        packet,
        rawState: createEmptyRawState(),
      })
      .onConflictDoUpdate({
        target: pgIncidents.incidentId,
        set: {
          packet,
          updatedAt: new Date(),
        },
      });
  }

  async updateIncidentStatus(id: string, status: "open" | "closed"): Promise<void> {
    await this.db
      .update(pgIncidents)
      .set({
        status,
        ...(status === "closed" ? { closedAt: new Date().toISOString() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(pgIncidents.incidentId, id));
  }

  async appendDiagnosis(id: string, result: DiagnosisResult): Promise<void> {
    await this.db
      .update(pgIncidents)
      .set({ diagnosisResult: result, updatedAt: new Date() })
      .where(eq(pgIncidents.incidentId, id));
  }

  async appendRawEvidence(
    incidentId: string,
    update: { metricEvidence?: ChangedMetric[]; logEvidence?: RelevantLog[] },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(pgIncidents)
        .where(eq(pgIncidents.incidentId, incidentId))
        .for("update");
      if (!row) return;
      const current = row.rawState ? (row.rawState as IncidentRawState) : createEmptyRawState();
      const rawState: IncidentRawState = {
        ...current,
        metricEvidence: [...current.metricEvidence, ...(update.metricEvidence ?? [])],
        logEvidence: [...current.logEvidence, ...(update.logEvidence ?? [])],
      };
      await tx.update(pgIncidents)
        .set({ rawState, updatedAt: new Date() })
        .where(eq(pgIncidents.incidentId, incidentId));
    });
  }

  async listIncidents(opts: { limit: number; cursor?: string }): Promise<IncidentPage> {
    const offset = opts.cursor !== undefined ? parseInt(opts.cursor, 10) : 0;
    const rows = await this.db
      .select()
      .from(pgIncidents)
      .orderBy(desc(pgIncidents.openedAt))
      .limit(opts.limit)
      .offset(offset);

    const [{ total }] = await this.db
      .select({ total: count() })
      .from(pgIncidents);

    const nextOffset = offset + opts.limit;
    return {
      items: rows.map((r) => this.toIncident(r)),
      nextCursor: nextOffset < Number(total) ? String(nextOffset) : undefined,
    };
  }

  async getIncident(id: string): Promise<Incident | null> {
    const [row] = await this.db
      .select()
      .from(pgIncidents)
      .where(eq(pgIncidents.incidentId, id));
    return row ? this.toIncident(row) : null;
  }

  async getIncidentByPacketId(packetId: string): Promise<Incident | null> {
    // Use JSONB containment operator for efficient lookup
    const [row] = await this.db
      .select()
      .from(pgIncidents)
      .where(drizzleSql`${pgIncidents.packet}->>'packetId' = ${packetId}`);
    return row ? this.toIncident(row) : null;
  }

  async deleteExpiredIncidents(before: Date): Promise<void> {
    await this.db
      .delete(pgIncidents)
      .where(
        and(
          eq(pgIncidents.status, "closed"),
          lt(pgIncidents.openedAt, before.toISOString()),
        ),
      );
  }

  async appendSpans(incidentId: string, spans: ExtractedSpan[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(pgIncidents)
        .where(eq(pgIncidents.incidentId, incidentId))
        .for("update");
      if (!row) return;
      const current = row.rawState ? (row.rawState as IncidentRawState) : createEmptyRawState();
      const rawState: IncidentRawState = { ...current, spans: [...current.spans, ...spans] };
      await tx.update(pgIncidents)
        .set({ rawState, updatedAt: new Date() })
        .where(eq(pgIncidents.incidentId, incidentId));
    });
  }

  async appendAnomalousSignals(incidentId: string, signals: AnomalousSignal[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(pgIncidents)
        .where(eq(pgIncidents.incidentId, incidentId))
        .for("update");
      if (!row) return;
      const current = row.rawState ? (row.rawState as IncidentRawState) : createEmptyRawState();
      const rawState: IncidentRawState = {
        ...current,
        anomalousSignals: [...current.anomalousSignals, ...signals],
      };
      await tx.update(pgIncidents)
        .set({ rawState, updatedAt: new Date() })
        .where(eq(pgIncidents.incidentId, incidentId));
    });
  }

  async appendPlatformEvents(incidentId: string, events: PlatformEvent[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(pgIncidents)
        .where(eq(pgIncidents.incidentId, incidentId))
        .for("update");
      if (!row) return;
      const current = row.rawState ? (row.rawState as IncidentRawState) : createEmptyRawState();
      const rawState: IncidentRawState = {
        ...current,
        platformEvents: [...current.platformEvents, ...events],
      };
      await tx.update(pgIncidents)
        .set({ rawState, updatedAt: new Date() })
        .where(eq(pgIncidents.incidentId, incidentId));
    });
  }

  async getRawState(incidentId: string): Promise<IncidentRawState | null> {
    const incident = await this.getIncident(incidentId);
    return incident ? incident.rawState : null;
  }

  async saveThinEvent(event: ThinEvent): Promise<void> {
    await this.db.insert(pgThinEvents).values({
      eventId: event.event_id,
      eventType: event.event_type,
      incidentId: event.incident_id,
      packetId: event.packet_id,
    });
  }

  async listThinEvents(): Promise<ThinEvent[]> {
    const rows = await this.db.select().from(pgThinEvents).orderBy(pgThinEvents.id);
    return rows.map((r) => ({
      event_id: r.eventId,
      event_type: r.eventType as ThinEvent["event_type"],
      incident_id: r.incidentId,
      packet_id: r.packetId,
    }));
  }
}
