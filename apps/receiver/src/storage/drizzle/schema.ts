/**
 * Drizzle schema — SQLite only (used by SQLiteAdapter).
 *
 * PostgresAdapter defines its own PG-specific schema inline using pgTable/jsonb.
 * SQLite stores IncidentPacket and DiagnosisResult as JSON text strings.
 */
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// ── SQLite schema (used by SQLiteAdapter and for shared migration baseline) ─

export const incidents = sqliteTable("incidents", {
  incidentId: text("incident_id").primaryKey(),
  status: text("status", { enum: ["open", "closed"] }).notNull().default("open"),
  openedAt: text("opened_at").notNull(),
  closedAt: text("closed_at"),
  packet: text("packet").notNull(),           // JSON string of IncidentPacket
  diagnosisResult: text("diagnosis_result"),  // JSON string of DiagnosisResult | null
  rawState: text("raw_state"),                // JSON string — kept nullable for lazy migration (DJ-6)
  telemetryScope: text("telemetry_scope"),    // JSON string of TelemetryScope | null
  spanMembership: text("span_membership"),    // JSON string of string[] | null
  anomalousSignals: text("anomalous_signals"),// JSON string of AnomalousSignal[] | null
  platformEvents: text("platform_events"),    // JSON string of PlatformEvent[] | null
  diagnosisDispatchedAt: text("diagnosis_dispatched_at"), // ISO timestamp | null
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export const thinEvents = sqliteTable("thin_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventId: text("event_id").notNull().unique(),
  eventType: text("event_type").notNull(),
  incidentId: text("incident_id").notNull(),
  packetId: text("packet_id").notNull(),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type IncidentsTable = typeof incidents;
export type ThinEventsTable = typeof thinEvents;
export type SettingsTable = typeof settings;
