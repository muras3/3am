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

// ── Postgres-specific table definitions (JSONB, timestamptz) ─────────────────

const pgIncidents = pgTable("incidents", {
  incidentId: text("incident_id").primaryKey(),
  status: text("status", { enum: ["open", "closed"] as const }).notNull().default("open"),
  openedAt: text("opened_at").notNull(),
  closedAt: text("closed_at"),
  packet: jsonb("packet").notNull(),
  diagnosisResult: jsonb("diagnosis_result"),
  rawState: jsonb("raw_state"),                   // kept nullable for lazy migration (DJ-6)
  telemetryScope: jsonb("telemetry_scope"),
  spanMembership: jsonb("span_membership"),
  anomalousSignals: jsonb("anomalous_signals"),
  platformEvents: jsonb("platform_events"),
  diagnosisDispatchedAt: timestamp("diagnosis_dispatched_at", { withTimezone: true }),
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

const pgSettings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

type PgSchema = { pgIncidents: typeof pgIncidents; pgThinEvents: typeof pgThinEvents; pgSettings: typeof pgSettings };

// ── PostgresAdapter ─────────────────────────────────────────────────────────

export class PostgresAdapter implements StorageDriver {
  private db: PostgresJsDatabase<PgSchema>;
  private client: ReturnType<typeof postgres>;

  constructor(connectionString?: string) {
    const url = connectionString ?? process.env["DATABASE_URL"];
    if (!url) throw new Error("DATABASE_URL is required for PostgresAdapter");
    this.client = postgres(url, { max: 10, prepare: false, connect_timeout: 10 });
    this.db = drizzle(this.client, { schema: { pgIncidents, pgThinEvents, pgSettings } });
  }

  /** Run DDL to create tables if they don't exist. Call once at startup. */
  async migrate(): Promise<void> {
    await this.db.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS incidents (
        incident_id        TEXT PRIMARY KEY,
        status             TEXT NOT NULL DEFAULT 'open',
        opened_at          TEXT NOT NULL,
        closed_at          TEXT,
        packet             JSONB NOT NULL,
        diagnosis_result   JSONB,
        raw_state          JSONB,
        telemetry_scope    JSONB,
        span_membership    JSONB,
        anomalous_signals  JSONB,
        platform_events    JSONB,
        diagnosis_dispatched_at TIMESTAMPTZ,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // Add new columns to existing tables (idempotent)
    await this.db.execute(drizzleSql`
      ALTER TABLE incidents ADD COLUMN IF NOT EXISTS telemetry_scope JSONB
    `);
    await this.db.execute(drizzleSql`
      ALTER TABLE incidents ADD COLUMN IF NOT EXISTS span_membership JSONB
    `);
    await this.db.execute(drizzleSql`
      ALTER TABLE incidents ADD COLUMN IF NOT EXISTS anomalous_signals JSONB
    `);
    await this.db.execute(drizzleSql`
      ALTER TABLE incidents ADD COLUMN IF NOT EXISTS platform_events JSONB
    `);
    await this.db.execute(drizzleSql`
      ALTER TABLE incidents ADD COLUMN IF NOT EXISTS diagnosis_dispatched_at TIMESTAMPTZ
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
    await this.db.execute(drizzleSql`
      CREATE TABLE IF NOT EXISTS settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
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
    const packet = row.packet as IncidentPacket;
    const rawState = row.rawState as LegacyRawState | null;

    const incident: Incident = {
      incidentId: row.incidentId,
      status: row.status as "open" | "closed",
      openedAt: row.openedAt,
      packet,
      telemetryScope: row.telemetryScope
        ? (row.telemetryScope as TelemetryScope)
        : deriveTelemetryScopeFromPacket(packet),
      spanMembership: row.spanMembership
        ? (row.spanMembership as string[])
        : deriveSpanMembershipFromRawState(rawState),
      anomalousSignals: row.anomalousSignals
        ? (row.anomalousSignals as AnomalousSignal[])
        : deriveAnomalousSignalsFromRawState(rawState),
      platformEvents: row.platformEvents
        ? (row.platformEvents as PlatformEvent[])
        : derivePlatformEventsFromRawState(rawState, packet),
    };
    if (row.closedAt) incident.closedAt = row.closedAt;
    if (row.diagnosisResult) {
      incident.diagnosisResult = row.diagnosisResult as DiagnosisResult;
    }
    if (row.diagnosisDispatchedAt) {
      incident.diagnosisDispatchedAt = row.diagnosisDispatchedAt.toISOString();
    }
    return incident;
  }

  async createIncident(packet: IncidentPacket, membership: InitialMembership): Promise<void> {
    await this.db
      .insert(pgIncidents)
      .values({
        incidentId: packet.incidentId,
        status: "open",
        openedAt: packet.openedAt,
        packet,
        telemetryScope: membership.telemetryScope,
        spanMembership: membership.spanMembership,
        anomalousSignals: membership.anomalousSignals,
        platformEvents: [],
      })
      .onConflictDoNothing(); // no-op if already exists
  }

  async updatePacket(incidentId: string, packet: IncidentPacket): Promise<void> {
    await this.db
      .update(pgIncidents)
      .set({ packet, updatedAt: new Date() })
      .where(eq(pgIncidents.incidentId, incidentId));
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

  async expandTelemetryScope(
    incidentId: string,
    expansion: { windowStartMs: number; windowEndMs: number; memberServices: string[]; dependencyServices: string[] },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(pgIncidents)
        .where(eq(pgIncidents.incidentId, incidentId))
        .for("update");
      if (!row) return;
      const current = row.telemetryScope
        ? (row.telemetryScope as TelemetryScope)
        : deriveTelemetryScopeFromPacket(row.packet as IncidentPacket);
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
      await tx.update(pgIncidents)
        .set({ telemetryScope: updated, updatedAt: new Date() })
        .where(eq(pgIncidents.incidentId, incidentId));
    });
  }

  async appendSpanMembership(incidentId: string, spanIds: string[]): Promise<void> {
    if (spanIds.length === 0) return;
    await this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(pgIncidents)
        .where(eq(pgIncidents.incidentId, incidentId))
        .for("update");
      if (!row) return;
      const current = row.spanMembership
        ? (row.spanMembership as string[])
        : deriveSpanMembershipFromRawState(row.rawState as LegacyRawState | null);
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
      await tx.update(pgIncidents)
        .set({ spanMembership: updated, updatedAt: new Date() })
        .where(eq(pgIncidents.incidentId, incidentId));
    });
  }

  async appendAnomalousSignals(incidentId: string, signals: AnomalousSignal[]): Promise<void> {
    if (signals.length === 0) return;
    await this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(pgIncidents)
        .where(eq(pgIncidents.incidentId, incidentId))
        .for("update");
      if (!row) return;
      const current = row.anomalousSignals
        ? (row.anomalousSignals as AnomalousSignal[])
        : deriveAnomalousSignalsFromRawState(row.rawState as LegacyRawState | null);
      let updated = [...current, ...signals];
      if (updated.length > MAX_ANOMALOUS_SIGNALS) {
        updated = updated.slice(updated.length - MAX_ANOMALOUS_SIGNALS);
      }
      await tx.update(pgIncidents)
        .set({ anomalousSignals: updated, updatedAt: new Date() })
        .where(eq(pgIncidents.incidentId, incidentId));
    });
  }

  async appendPlatformEvents(incidentId: string, events: PlatformEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(pgIncidents)
        .where(eq(pgIncidents.incidentId, incidentId))
        .for("update");
      if (!row) return;
      const current = row.platformEvents
        ? (row.platformEvents as PlatformEvent[])
        : derivePlatformEventsFromRawState(
            row.rawState as LegacyRawState | null,
            row.packet as IncidentPacket,
          );
      const updated = [...current, ...events];
      await tx.update(pgIncidents)
        .set({ platformEvents: updated, updatedAt: new Date() })
        .where(eq(pgIncidents.incidentId, incidentId));
    });
  }

  async claimDiagnosisDispatch(incidentId: string): Promise<boolean> {
    const rows = await this.db
      .update(pgIncidents)
      .set({ diagnosisDispatchedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(pgIncidents.incidentId, incidentId),
          drizzleSql`${pgIncidents.diagnosisDispatchedAt} IS NULL`,
        ),
      )
      .returning({ incidentId: pgIncidents.incidentId });
    return rows.length > 0;
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

  async getSettings(key: string): Promise<string | null> {
    const [row] = await this.db.select().from(pgSettings).where(eq(pgSettings.key, key));
    return row?.value ?? null;
  }

  async setSettings(key: string, value: string): Promise<void> {
    await this.db
      .insert(pgSettings)
      .values({ key, value })
      .onConflictDoUpdate({ target: pgSettings.key, set: { value, updatedAt: new Date() } });
  }
}
