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
import type { IncidentPacket, DiagnosisResult, PlatformEvent, ThinEvent } from "@3amoncall/core";
import type {
  AnomalousSignal,
  Incident,
  IncidentPage,
  InitialMembership,
  StorageDriver,
  TelemetryScope,
} from "../interface.js";
import { MAX_ANOMALOUS_SIGNALS, MAX_SPAN_MEMBERSHIP } from "../interface.js";
import type { LegacyRawState } from "./lazy-migration.js";
import {
  deriveTelemetryScopeFromPacket,
  deriveSpanMembershipFromRawState,
  deriveAnomalousSignalsFromRawState,
  derivePlatformEventsFromRawState,
} from "./lazy-migration.js";
import { incidents, thinEvents } from "./schema.js";

type Schema = { incidents: typeof incidents; thinEvents: typeof thinEvents };

// ── SQLiteAdapter ───────────────────────────────────────────────────────────

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
        incident_id       TEXT PRIMARY KEY,
        status            TEXT NOT NULL DEFAULT 'open',
        opened_at         TEXT NOT NULL,
        closed_at         TEXT,
        packet            TEXT NOT NULL,
        diagnosis_result  TEXT,
        raw_state         TEXT,
        telemetry_scope   TEXT,
        span_membership   TEXT,
        anomalous_signals TEXT,
        platform_events   TEXT,
        created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `);
    // Add new columns to existing tables (SQLite has no IF NOT EXISTS for ADD COLUMN)
    for (const col of [
      "telemetry_scope TEXT",
      "span_membership TEXT",
      "anomalous_signals TEXT",
      "platform_events TEXT",
    ]) {
      try {
        this.db.run(sql.raw(`ALTER TABLE incidents ADD COLUMN ${col}`));
      } catch {
        // Column already exists — ignore
      }
    }
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
    const packet = JSON.parse(row.packet) as IncidentPacket;
    const rawState = row.rawState ? (JSON.parse(row.rawState) as LegacyRawState) : null;

    const incident: Incident = {
      incidentId: row.incidentId,
      status: row.status,
      openedAt: row.openedAt,
      packet,
      telemetryScope: row.telemetryScope
        ? (JSON.parse(row.telemetryScope) as TelemetryScope)
        : deriveTelemetryScopeFromPacket(packet),
      spanMembership: row.spanMembership
        ? (JSON.parse(row.spanMembership) as string[])
        : deriveSpanMembershipFromRawState(rawState),
      anomalousSignals: row.anomalousSignals
        ? (JSON.parse(row.anomalousSignals) as AnomalousSignal[])
        : deriveAnomalousSignalsFromRawState(rawState),
      platformEvents: row.platformEvents
        ? (JSON.parse(row.platformEvents) as PlatformEvent[])
        : derivePlatformEventsFromRawState(rawState, packet),
    };
    if (row.closedAt) incident.closedAt = row.closedAt;
    if (row.diagnosisResult) {
      incident.diagnosisResult = JSON.parse(row.diagnosisResult) as DiagnosisResult;
    }
    return incident;
  }

  async createIncident(packet: IncidentPacket, membership: InitialMembership): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insert(incidents)
      .values({
        incidentId: packet.incidentId,
        status: "open",
        openedAt: packet.openedAt,
        packet: JSON.stringify(packet),
        telemetryScope: JSON.stringify(membership.telemetryScope),
        spanMembership: JSON.stringify(membership.spanMembership),
        anomalousSignals: JSON.stringify(membership.anomalousSignals),
        platformEvents: JSON.stringify([]),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing(); // no-op if already exists
  }

  async updatePacket(incidentId: string, packet: IncidentPacket): Promise<void> {
    await this.db
      .update(incidents)
      .set({ packet: JSON.stringify(packet), updatedAt: new Date().toISOString() })
      .where(eq(incidents.incidentId, incidentId));
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

  async expandTelemetryScope(
    incidentId: string,
    expansion: { windowStartMs: number; windowEndMs: number; memberServices: string[]; dependencyServices: string[] },
  ): Promise<void> {
    this.db.transaction((tx) => {
      const [row] = tx.select().from(incidents).where(eq(incidents.incidentId, incidentId)).all();
      if (!row) return;
      const current = row.telemetryScope
        ? (JSON.parse(row.telemetryScope) as TelemetryScope)
        : deriveTelemetryScopeFromPacket(JSON.parse(row.packet) as IncidentPacket);
      const memberSet = new Set(current.memberServices);
      for (const s of expansion.memberServices) memberSet.add(s);
      const depSet = new Set(current.dependencyServices);
      for (const s of expansion.dependencyServices) depSet.add(s);
      const updated: TelemetryScope = {
        ...current,
        windowStartMs: Math.min(current.windowStartMs, expansion.windowStartMs),
        windowEndMs: Math.max(current.windowEndMs, expansion.windowEndMs),
        memberServices: [...memberSet],
        dependencyServices: [...depSet],
      };
      tx.update(incidents)
        .set({ telemetryScope: JSON.stringify(updated), updatedAt: new Date().toISOString() })
        .where(eq(incidents.incidentId, incidentId))
        .run();
    });
  }

  async appendSpanMembership(incidentId: string, spanIds: string[]): Promise<void> {
    if (spanIds.length === 0) return;
    this.db.transaction((tx) => {
      const [row] = tx.select().from(incidents).where(eq(incidents.incidentId, incidentId)).all();
      if (!row) return;
      const rawState = row.rawState ? (JSON.parse(row.rawState) as LegacyRawState) : null;
      const current = row.spanMembership
        ? (JSON.parse(row.spanMembership) as string[])
        : deriveSpanMembershipFromRawState(rawState);
      const existing = new Set(current);
      let updated = [...current];
      for (const id of spanIds) {
        if (!existing.has(id)) {
          updated.push(id);
          existing.add(id);
        }
      }
      // Cap: drop oldest entries when exceeding MAX_SPAN_MEMBERSHIP
      if (updated.length > MAX_SPAN_MEMBERSHIP) {
        updated = updated.slice(updated.length - MAX_SPAN_MEMBERSHIP);
      }
      tx.update(incidents)
        .set({ spanMembership: JSON.stringify(updated), updatedAt: new Date().toISOString() })
        .where(eq(incidents.incidentId, incidentId))
        .run();
    });
  }

  async appendAnomalousSignals(incidentId: string, signals: AnomalousSignal[]): Promise<void> {
    if (signals.length === 0) return;
    this.db.transaction((tx) => {
      const [row] = tx.select().from(incidents).where(eq(incidents.incidentId, incidentId)).all();
      if (!row) return;
      const rawState = row.rawState ? (JSON.parse(row.rawState) as LegacyRawState) : null;
      const current = row.anomalousSignals
        ? (JSON.parse(row.anomalousSignals) as AnomalousSignal[])
        : deriveAnomalousSignalsFromRawState(rawState);
      let updated = [...current, ...signals];
      if (updated.length > MAX_ANOMALOUS_SIGNALS) {
        updated = updated.slice(updated.length - MAX_ANOMALOUS_SIGNALS);
      }
      tx.update(incidents)
        .set({ anomalousSignals: JSON.stringify(updated), updatedAt: new Date().toISOString() })
        .where(eq(incidents.incidentId, incidentId))
        .run();
    });
  }

  async appendPlatformEvents(incidentId: string, events: PlatformEvent[]): Promise<void> {
    if (events.length === 0) return;
    this.db.transaction((tx) => {
      const [row] = tx.select().from(incidents).where(eq(incidents.incidentId, incidentId)).all();
      if (!row) return;
      const rawState = row.rawState ? (JSON.parse(row.rawState) as LegacyRawState) : null;
      const current = row.platformEvents
        ? (JSON.parse(row.platformEvents) as PlatformEvent[])
        : derivePlatformEventsFromRawState(rawState, JSON.parse(row.packet) as IncidentPacket);
      const updated = [...current, ...events];
      tx.update(incidents)
        .set({ platformEvents: JSON.stringify(updated), updatedAt: new Date().toISOString() })
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
