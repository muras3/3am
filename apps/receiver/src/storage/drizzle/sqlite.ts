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
import type { IncidentPacket, DiagnosisResult, ConsoleNarrative, PlatformEvent, ThinEvent } from "3am-core";
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
import {
  parseAnomalousSignals,
  parseConsoleNarrative,
  parseDiagnosisResult,
  parseIncidentPacket,
  parsePlatformEvents,
  parseSpanMembership,
  parseTelemetryScope,
  parseThinEvent,
} from "./validation.js";
import { incidents, thinEvents, settings } from "./schema.js";

type Schema = { incidents: typeof incidents; thinEvents: typeof thinEvents; settings: typeof settings };

// ── SQLiteAdapter ───────────────────────────────────────────────────────────

export class SQLiteAdapter implements StorageDriver {
  private db: BetterSQLite3Database<Schema>;
  private rawConn: InstanceType<typeof Database>;

  constructor(dbPathOrConnection: string | InstanceType<typeof Database> = ":memory:") {
    const conn =
      typeof dbPathOrConnection === "string"
        ? new Database(dbPathOrConnection)
        : dbPathOrConnection;
    this.rawConn = conn;
    this.db = drizzle(conn, { schema: { incidents, thinEvents, settings } });
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
        last_activity_at  TEXT NOT NULL,
        packet            TEXT NOT NULL,
        diagnosis_result  TEXT,
        console_narrative TEXT,
        raw_state         TEXT,
        telemetry_scope   TEXT,
        span_membership   TEXT,
        anomalous_signals TEXT,
        platform_events   TEXT,
        diagnosis_scheduled_at TEXT,
        diagnosis_dispatched_at TEXT,
        materialization_claimed_at TEXT,
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
      "diagnosis_scheduled_at TEXT",
      "diagnosis_dispatched_at TEXT",
      "materialization_claimed_at TEXT",
      "console_narrative TEXT",
      "last_activity_at TEXT",
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
    this.db.run(sql`
      CREATE TABLE IF NOT EXISTS settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `);
  }

  private toIncident(row: typeof incidents.$inferSelect): Incident {
    const packet = parseIncidentPacket(JSON.parse(row.packet));
    const rawState = row.rawState ? (JSON.parse(row.rawState) as LegacyRawState) : null;

    const incident: Incident = {
      incidentId: row.incidentId,
      status: row.status,
      openedAt: row.openedAt,
      lastActivityAt: row.lastActivityAt ?? row.updatedAt,
      packet,
      telemetryScope: row.telemetryScope
        ? parseTelemetryScope(JSON.parse(row.telemetryScope))
        : deriveTelemetryScopeFromPacket(packet),
      spanMembership: row.spanMembership
        ? parseSpanMembership(JSON.parse(row.spanMembership))
        : deriveSpanMembershipFromRawState(rawState),
      anomalousSignals: row.anomalousSignals
        ? parseAnomalousSignals(JSON.parse(row.anomalousSignals))
        : deriveAnomalousSignalsFromRawState(rawState),
      platformEvents: row.platformEvents
        ? parsePlatformEvents(JSON.parse(row.platformEvents))
        : derivePlatformEventsFromRawState(rawState, packet),
    };
    if (row.closedAt) incident.closedAt = row.closedAt;
    if (row.diagnosisResult) {
      incident.diagnosisResult = parseDiagnosisResult(JSON.parse(row.diagnosisResult));
    }
    if (row.consoleNarrative) {
      incident.consoleNarrative = parseConsoleNarrative(JSON.parse(row.consoleNarrative));
    }
    if (row.diagnosisScheduledAt) {
      incident.diagnosisScheduledAt = row.diagnosisScheduledAt;
    }
    if (row.diagnosisDispatchedAt) {
      incident.diagnosisDispatchedAt = row.diagnosisDispatchedAt;
    }
    return incident;
  }

  async nextIncidentSequence(): Promise<number> {
    return this.db.transaction((tx) => {
      const [row] = tx.select().from(settings).where(eq(settings.key, "__next_incident_sequence")).all();
      let current = row ? Number.parseInt(row.value, 10) : 0;
      if (!row) {
        const [latest] = tx.select({ incidentId: incidents.incidentId })
          .from(incidents)
          .orderBy(desc(incidents.incidentId))
          .limit(1)
          .all();
        current = latest ? parseIncidentSequence(latest.incidentId) ?? 0 : 0;
      }
      const next = current + 1;
      tx.insert(settings)
        .values({ key: "__next_incident_sequence", value: String(next), updatedAt: new Date().toISOString() })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: String(next), updatedAt: new Date().toISOString() },
        })
        .run();
      return next;
    });
  }

  async createIncident(packet: IncidentPacket, membership: InitialMembership): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insert(incidents)
      .values({
        incidentId: packet.incidentId,
        status: "open",
        openedAt: packet.openedAt,
        lastActivityAt: packet.openedAt,
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
        ...(status === "closed" ? { closedAt: now } : { closedAt: null }),
        updatedAt: now,
      })
      .where(eq(incidents.incidentId, id));
  }

  async touchIncidentActivity(id: string, at = new Date().toISOString()): Promise<void> {
    await this.db
      .update(incidents)
      .set({ lastActivityAt: at, updatedAt: at })
      .where(eq(incidents.incidentId, id));
  }

  async appendDiagnosis(id: string, result: DiagnosisResult): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .update(incidents)
      .set({
        diagnosisResult: JSON.stringify(result),
        diagnosisScheduledAt: null,
        diagnosisDispatchedAt: null,
        updatedAt: now,
      })
      .where(eq(incidents.incidentId, id));
  }

  async appendConsoleNarrative(id: string, narrative: ConsoleNarrative): Promise<void> {
    await this.db
      .update(incidents)
      .set({ consoleNarrative: JSON.stringify(narrative), updatedAt: new Date().toISOString() })
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
        .set({
          telemetryScope: JSON.stringify(updated),
          lastActivityAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
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
        .set({
          spanMembership: JSON.stringify(updated),
          lastActivityAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
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
        .set({
          anomalousSignals: JSON.stringify(updated),
          lastActivityAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
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
        .set({
          platformEvents: JSON.stringify(updated),
          lastActivityAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(incidents.incidentId, incidentId))
        .run();
    });
  }

  async claimMaterializationLease(incidentId: string, leaseMs = 60_000): Promise<boolean> {
    const now = new Date().toISOString();
    const staleBefore = new Date(Date.now() - leaseMs).toISOString();
    const result = this.db
      .update(incidents)
      .set({ materializationClaimedAt: now, updatedAt: now })
      .where(
        and(
          eq(incidents.incidentId, incidentId),
          sql`(${incidents.materializationClaimedAt} IS NULL OR ${incidents.materializationClaimedAt} < ${staleBefore})`,
        ),
      )
      .run();
    return result.changes > 0;
  }

  async releaseMaterializationLease(incidentId: string): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .update(incidents)
      .set({ materializationClaimedAt: null, updatedAt: now })
      .where(eq(incidents.incidentId, incidentId))
      .run();
  }

  async claimDiagnosisDispatch(incidentId: string, leaseMs = 15 * 60_000): Promise<boolean> {
    const now = new Date().toISOString();
    const staleBefore = new Date(Date.now() - leaseMs).toISOString();
    const result = this.db
      .update(incidents)
      .set({ diagnosisDispatchedAt: now, updatedAt: now })
      .where(
        and(
          eq(incidents.incidentId, incidentId),
          sql`(${incidents.diagnosisDispatchedAt} IS NULL OR ${incidents.diagnosisDispatchedAt} < ${staleBefore})`,
        ),
      )
      .run();
    return result.changes > 0;
  }

  async releaseDiagnosisDispatch(incidentId: string): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .update(incidents)
      .set({ diagnosisDispatchedAt: null, updatedAt: now })
      .where(eq(incidents.incidentId, incidentId))
      .run();
  }

  async markDiagnosisScheduled(incidentId: string, at?: string): Promise<void> {
    const now = at ?? new Date().toISOString();
    this.db
      .update(incidents)
      .set({ diagnosisScheduledAt: now, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(incidents.incidentId, incidentId),
          sql`${incidents.diagnosisScheduledAt} IS NULL`,
        ),
      )
      .run();
  }

  async clearDiagnosisScheduled(incidentId: string): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .update(incidents)
      .set({ diagnosisScheduledAt: null, updatedAt: now })
      .where(eq(incidents.incidentId, incidentId))
      .run();
  }

  async listIncidents(opts: { limit: number; cursor?: string }): Promise<IncidentPage> {
    const offset = opts.cursor !== undefined ? parseInt(opts.cursor, 10) : 0;
    const rows = await this.db
      .select()
      .from(incidents)
      .orderBy(desc(incidents.openedAt))
      .limit(opts.limit)
      .offset(offset);

    const countRows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(incidents);
    const count = countRows[0]?.count ?? 0;

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
          lt(incidents.closedAt, before.toISOString()),
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
    return rows.map((r) => parseThinEvent({
      event_id: r.eventId,
      event_type: r.eventType as ThinEvent["event_type"],
      incident_id: r.incidentId,
      packet_id: r.packetId,
    }));
  }

  async getSettings(key: string): Promise<string | null> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, key));
    return row?.value ?? null;
  }

  async setSettings(key: string, value: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insert(settings)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
  }

  async consumeRateLimit(key: string, windowMs: number, max: number, now = Date.now()): Promise<boolean> {
    const bucketStart = now - (now % windowMs);
    const bucketKey = `rl:${windowMs}:${bucketStart}:${key}`;
    const row = this.rawConn.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, '1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(key) DO UPDATE SET
        value = CASE
          WHEN CAST(settings.value AS INTEGER) >= ? THEN settings.value
          ELSE CAST(CAST(settings.value AS INTEGER) + 1 AS TEXT)
        END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      RETURNING CAST(value AS INTEGER) AS count
    `).get(bucketKey, max) as { count?: number } | undefined;
    return typeof row?.count === "number" && row.count <= max;
  }
}

function parseIncidentSequence(incidentId: string): number | null {
  const match = incidentId.match(/^inc_(\d{6})$/);
  const digits = match?.[1];
  return digits ? Number.parseInt(digits, 10) : null;
}
