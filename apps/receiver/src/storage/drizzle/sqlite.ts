/**
 * SQLiteAdapter — StorageDriver backed by better-sqlite3 + Drizzle.
 *
 * Primary uses:
 *  - In-memory SQLite for unit / integration tests (new Database(':memory:'))
 *  - Local development without Docker
 *  - Approximation of Cloudflare D1 (same dialect)
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq, desc, lt, and } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { IncidentPacket, DiagnosisResult, PlatformEvent, ThinEvent, ChangedMetric, RelevantLog } from "@3amoncall/core";
import type { ExtractedSpan } from "../../domain/anomaly-detector.js";
import type { AnomalousSignal, Incident, IncidentPage, IncidentRawState, StorageDriver } from "../interface.js";
import { createEmptyRawState } from "../interface.js";
import { incidents, thinEvents } from "./schema.js";

type Schema = { incidents: typeof incidents; thinEvents: typeof thinEvents };

export class SQLiteAdapter implements StorageDriver {
  private db: BetterSQLite3Database<Schema>;

  constructor(dbPathOrConnection: string | InstanceType<typeof Database> = ":memory:") {
    const conn =
      typeof dbPathOrConnection === "string"
        ? new Database(dbPathOrConnection)
        : dbPathOrConnection;
    this.db = drizzle(conn, { schema: { incidents, thinEvents } });
    this.migrate();
  }

  /** Run inline DDL — no drizzle-kit needed at runtime. */
  private migrate(): void {
    this.db.run(sql`
      CREATE TABLE IF NOT EXISTS incidents (
        incident_id     TEXT PRIMARY KEY,
        status          TEXT NOT NULL DEFAULT 'open',
        opened_at       TEXT NOT NULL,
        closed_at       TEXT,
        packet          TEXT NOT NULL,
        diagnosis_result TEXT,
        raw_state       TEXT,
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `);
    this.db.run(sql`
      CREATE TABLE IF NOT EXISTS thin_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id    TEXT NOT NULL UNIQUE,
        event_type  TEXT NOT NULL,
        incident_id TEXT NOT NULL,
        packet_id   TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `);
    this.db.run(sql`
      CREATE INDEX IF NOT EXISTS idx_incidents_opened_at ON incidents(opened_at DESC)
    `);
    this.db.run(sql`
      CREATE INDEX IF NOT EXISTS idx_incidents_packet_id ON incidents(json_extract(packet, '$.packetId'))
    `);
  }

  private toIncident(row: typeof incidents.$inferSelect): Incident {
    const incident: Incident = {
      incidentId: row.incidentId,
      status: row.status,
      openedAt: row.openedAt,
      packet: JSON.parse(row.packet) as IncidentPacket,
      rawState: row.rawState ? (JSON.parse(row.rawState) as IncidentRawState) : createEmptyRawState(),
    };
    if (row.closedAt) incident.closedAt = row.closedAt;
    if (row.diagnosisResult) {
      incident.diagnosisResult = JSON.parse(row.diagnosisResult) as DiagnosisResult;
    }
    return incident;
  }

  async createIncident(packet: IncidentPacket): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insert(incidents)
      .values({
        incidentId: packet.incidentId,
        status: "open",
        openedAt: packet.openedAt,
        packet: JSON.stringify(packet),
        rawState: JSON.stringify(createEmptyRawState()),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: incidents.incidentId,
        set: { packet: JSON.stringify(packet), updatedAt: now },
      });
  }

  async updateIncidentStatus(id: string, status: "open" | "closed"): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .update(incidents)
      .set({
        status,
        ...(status === "closed" ? { closedAt: now } : {}),
        updatedAt: now,
      })
      .where(eq(incidents.incidentId, id));
  }

  async appendDiagnosis(id: string, result: DiagnosisResult): Promise<void> {
    await this.db
      .update(incidents)
      .set({ diagnosisResult: JSON.stringify(result), updatedAt: new Date().toISOString() })
      .where(eq(incidents.incidentId, id));
  }

  async appendRawEvidence(
    incidentId: string,
    update: { metricEvidence?: ChangedMetric[]; logEvidence?: RelevantLog[] },
  ): Promise<void> {
    this.db.transaction((tx) => {
      const [row] = tx.select().from(incidents).where(eq(incidents.incidentId, incidentId)).all();
      if (!row) return;
      const current = row.rawState ? (JSON.parse(row.rawState) as IncidentRawState) : createEmptyRawState();
      const rawState: IncidentRawState = {
        ...current,
        metricEvidence: [...current.metricEvidence, ...(update.metricEvidence ?? [])],
        logEvidence: [...current.logEvidence, ...(update.logEvidence ?? [])],
      };
      tx.update(incidents)
        .set({ rawState: JSON.stringify(rawState), updatedAt: new Date().toISOString() })
        .where(eq(incidents.incidentId, incidentId))
        .run();
    });
  }

  async listIncidents(opts: { limit: number; cursor?: string }): Promise<IncidentPage> {
    const offset = opts.cursor !== undefined ? parseInt(opts.cursor, 10) : 0;
    const rows = await this.db
      .select()
      .from(incidents)
      .orderBy(desc(incidents.openedAt))
      .limit(opts.limit)
      .offset(offset);

    // Count total to determine if there are more results
    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(incidents);

    const nextOffset = offset + opts.limit;
    return {
      items: rows.map((r) => this.toIncident(r)),
      nextCursor: nextOffset < count ? String(nextOffset) : undefined,
    };
  }

  async getIncident(id: string): Promise<Incident | null> {
    const [row] = await this.db
      .select()
      .from(incidents)
      .where(eq(incidents.incidentId, id));
    return row ? this.toIncident(row) : null;
  }

  async getIncidentByPacketId(packetId: string): Promise<Incident | null> {
    const [row] = await this.db
      .select()
      .from(incidents)
      .where(sql`json_extract(${incidents.packet}, '$.packetId') = ${packetId}`);
    return row ? this.toIncident(row) : null;
  }

  async deleteExpiredIncidents(before: Date): Promise<void> {
    await this.db
      .delete(incidents)
      .where(
        and(
          eq(incidents.status, "closed"),
          lt(incidents.openedAt, before.toISOString()),
        ),
      );
  }

  async appendSpans(incidentId: string, spans: ExtractedSpan[]): Promise<void> {
    this.db.transaction((tx) => {
      const [row] = tx.select().from(incidents).where(eq(incidents.incidentId, incidentId)).all();
      if (!row) return;
      const current = row.rawState ? (JSON.parse(row.rawState) as IncidentRawState) : createEmptyRawState();
      const rawState: IncidentRawState = { ...current, spans: [...current.spans, ...spans] };
      tx.update(incidents)
        .set({ rawState: JSON.stringify(rawState), updatedAt: new Date().toISOString() })
        .where(eq(incidents.incidentId, incidentId))
        .run();
    });
  }

  async appendAnomalousSignals(incidentId: string, signals: AnomalousSignal[]): Promise<void> {
    this.db.transaction((tx) => {
      const [row] = tx.select().from(incidents).where(eq(incidents.incidentId, incidentId)).all();
      if (!row) return;
      const current = row.rawState ? (JSON.parse(row.rawState) as IncidentRawState) : createEmptyRawState();
      const rawState: IncidentRawState = {
        ...current,
        anomalousSignals: [...current.anomalousSignals, ...signals],
      };
      tx.update(incidents)
        .set({ rawState: JSON.stringify(rawState), updatedAt: new Date().toISOString() })
        .where(eq(incidents.incidentId, incidentId))
        .run();
    });
  }

  async appendPlatformEvents(incidentId: string, events: PlatformEvent[]): Promise<void> {
    this.db.transaction((tx) => {
      const [row] = tx.select().from(incidents).where(eq(incidents.incidentId, incidentId)).all();
      if (!row) return;
      const current = row.rawState ? (JSON.parse(row.rawState) as IncidentRawState) : createEmptyRawState();
      const rawState: IncidentRawState = {
        ...current,
        platformEvents: [...current.platformEvents, ...events],
      };
      tx.update(incidents)
        .set({ rawState: JSON.stringify(rawState), updatedAt: new Date().toISOString() })
        .where(eq(incidents.incidentId, incidentId))
        .run();
    });
  }

  async getRawState(incidentId: string): Promise<IncidentRawState | null> {
    const incident = await this.getIncident(incidentId);
    return incident ? incident.rawState : null;
  }

  async saveThinEvent(event: ThinEvent): Promise<void> {
    const now = new Date().toISOString();
    await this.db.insert(thinEvents).values({
      eventId: event.event_id,
      eventType: event.event_type,
      incidentId: event.incident_id,
      packetId: event.packet_id,
      createdAt: now,
    });
  }

  async listThinEvents(): Promise<ThinEvent[]> {
    const rows = await this.db.select().from(thinEvents).orderBy(thinEvents.id);
    return rows.map((r) => ({
      event_id: r.eventId,
      event_type: r.eventType as ThinEvent["event_type"],
      incident_id: r.incidentId,
      packet_id: r.packetId,
    }));
  }
}
