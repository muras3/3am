/**
 * Schema parity test — verifies SQLite and Postgres table schemas
 * have identical column sets via live DB introspection.
 *
 * SQLite tests always run (in-memory DB, no external dependency).
 * Postgres parity tests only run when DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import type postgres from "postgres";
import { SQLiteAdapter } from "../../storage/drizzle/sqlite.js";
import { PostgresAdapter } from "../../storage/drizzle/postgres.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function getSQLiteColumns(conn: InstanceType<typeof Database>, table: string): string[] {
  const rows = conn.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return rows.map((r) => r.name).sort();
}

// ── SQLite (always runs) ────────────────────────────────────────────────────

describe("Schema parity: SQLite vs Postgres", () => {
  let sqliteColumns: { incidents: string[]; thinEvents: string[] };

  beforeAll(() => {
    const conn = new Database(":memory:");
    // Constructor auto-migrates via inline DDL
    new SQLiteAdapter(conn);

    sqliteColumns = {
      incidents: getSQLiteColumns(conn, "incidents"),
      thinEvents: getSQLiteColumns(conn, "thin_events"),
    };
  });

  it("SQLite incidents table has expected columns", () => {
    expect(sqliteColumns.incidents).toEqual([
      "closed_at",
      "created_at",
      "diagnosis_result",
      "incident_id",
      "opened_at",
      "packet",
      "raw_state",
      "status",
      "updated_at",
    ]);
  });

  it("SQLite thin_events table has expected columns", () => {
    expect(sqliteColumns.thinEvents).toEqual([
      "created_at",
      "event_id",
      "event_type",
      "id",
      "incident_id",
      "packet_id",
    ]);
  });

  // ── Postgres parity (only when DATABASE_URL is set) ─────────────────────

  const DATABASE_URL = process.env["DATABASE_URL"];

  if (!DATABASE_URL) {
    describe("Postgres parity", () => {
      it.skip("skipped — DATABASE_URL not set", () => {});
    });
  } else {
    describe("Postgres parity", () => {
      let pgColumns: { incidents: string[]; thinEvents: string[] };
      let pgSql: postgres.Sql;
      let pgAdapter: PostgresAdapter;

      beforeAll(async () => {
        const pgClient = (await import("postgres")).default;

        pgAdapter = new PostgresAdapter(DATABASE_URL);
        await pgAdapter.migrate();

        // Use a separate lightweight connection for schema introspection
        pgSql = pgClient(DATABASE_URL, { max: 1 });

        const incidentRows: Array<{ column_name: string }> = await pgSql`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_name = 'incidents'
          ORDER BY ordinal_position
        `;
        const thinEventRows: Array<{ column_name: string }> = await pgSql`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_name = 'thin_events'
          ORDER BY ordinal_position
        `;

        pgColumns = {
          incidents: incidentRows.map((r) => r.column_name).sort(),
          thinEvents: thinEventRows.map((r) => r.column_name).sort(),
        };
      });

      afterAll(async () => {
        await pgSql?.end();
        await pgAdapter?.close();
      });

      it("incidents table columns match between SQLite and Postgres", () => {
        expect(new Set(pgColumns.incidents)).toEqual(
          new Set(sqliteColumns.incidents),
        );
      });

      it("thin_events table columns match between SQLite and Postgres", () => {
        expect(new Set(pgColumns.thinEvents)).toEqual(
          new Set(sqliteColumns.thinEvents),
        );
      });
    });
  }
});
