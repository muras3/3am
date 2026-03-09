## E3 Code Review — Round 2

Reviewer: Opus 4.6
Date: 2026-03-09
Commit under review: 7b2d356 (round 1 fix commit)
Context: Round 1 found 16 findings (3 major, 8 minor, 5 nit). 9 actionable fixes were applied. This round verifies those fixes and does a fresh pass for any remaining issues.

### Fix verification

| Fix | Status | Notes |
|-----|--------|-------|
| F-E3-001/016 (jsonb) | OK | `packet` and `diagnosisResult` now use `jsonb()` from `drizzle-orm/pg-core`. `JSON.stringify`/`JSON.parse` removed from postgres.ts. `toIncident` does `row.packet as IncidentPacket` — safe because Drizzle's `jsonb()` returns `unknown` at runtime and postgres.js delivers a parsed JS object. The old `typeof === "string"` branching is gone. `onConflictDoUpdate` with `set: { packet }` works correctly — Drizzle serializes JS objects to JSONB via `JSON.stringify` internally for `jsonb()` columns. Verified: typecheck passes, no runtime errors in tests. |
| F-E3-002 (json_extract) | OK | `getIncidentByPacketId` now uses `` sql`json_extract(${incidents.packet}, '$.packetId') = ${packetId}` ``. Drizzle's `sql` template tag correctly interpolates the column reference (no quoting issues) and parameterizes `packetId` as a bind variable. This eliminates the full-table-scan. Tested implicitly via the shared suite's `getIncidentByPacketId` tests. |
| F-E3-003 (schema.ts comment) | OK | Comment now correctly states "SQLite only" and explains that PostgresAdapter defines its own PG-specific schema inline. Accurate. |
| F-E3-004 (upsert packet assertion) | OK | `expect(incident?.packet.packetId).toBe("pkt_test_001_v2")` added at shared-suite.ts:117. This ensures the upsert actually updates the packet, closing the gap where a no-op adapter could pass. |
| F-E3-005 (status enum) | OK | `status: text("status", { enum: ["open", "closed"] as const })` added to pgIncidents. Drizzle now infers `status` as `"open" | "closed"`, making the `as` cast in `toIncident` (line 92) redundant but harmless. |
| F-E3-007 (opened_at index) | OK | `CREATE INDEX IF NOT EXISTS idx_incidents_opened_at ON incidents(opened_at DESC)` added to both `migrate()` methods. In both SQLite and Postgres, the index DDL runs after the table DDL, so the table always exists when the index is created. Order is correct. |
| F-E3-010 (duplicate event_id test) | OK | `saveThinEvent throws on duplicate event_id` test added at shared-suite.ts:254-258. Uses `rejects.toThrow()` which works for all 3 adapters: MemoryAdapter throws `Error("Duplicate event_id: ...")`, SQLiteAdapter throws a better-sqlite3 constraint error, and PostgresAdapter throws a postgres.js unique constraint error. All extend `Error`, so `rejects.toThrow()` catches all of them correctly. |
| F-E3-011 (appendDiagnosis no-op test) | OK | `appendDiagnosis is a no-op for unknown incidentId` test added at shared-suite.ts:159-162. Uses `resolves.toBeUndefined()`. Since all three adapters' `appendDiagnosis` return `Promise<void>`, the resolved value is `undefined`. This is correct — `void` functions resolve to `undefined` in JS. |
| F-E3-015 (pg_isready -U) | OK | ci.yml:29 now reads `pg_isready -U receiver`, matching docker-compose conventions. |

### New findings

#### F-E3-R2-001: `as "open" | "closed"` cast in PostgresAdapter.toIncident is now redundant [severity: nit]
**File**: apps/receiver/src/storage/drizzle/postgres.ts:92
**Description**: After F-E3-005, the Drizzle schema for `status` is `text("status", { enum: ["open", "closed"] as const })`. Drizzle's `$inferSelect` now types `row.status` as `"open" | "closed"`, making the explicit `as "open" | "closed"` cast unnecessary. Harmless but slightly misleading — a reader might think the cast is needed, suggesting the column type is wider than it actually is.
**Fix**: Remove the cast: `status: row.status,` instead of `status: row.status as "open" | "closed",`.

#### F-E3-R2-002: Stale packetIndex entry in MemoryAdapter on upsert (carried from round 1) [severity: minor]
**File**: apps/receiver/src/storage/adapters/memory.ts:25
**Description**: This was noted in round 1 as F-E3-012 and intentionally deferred. Confirming the behavioral divergence still exists: if you call `createIncident` twice with the same `incidentId` but different `packetId`s ("pkt_v1" then "pkt_v2"), MemoryAdapter's `getIncidentByPacketId("pkt_v1")` still returns the incident (stale entry), while SQLite and Postgres adapters return `null` (they query the live JSON). The shared test suite does not cover this case. This remains a known gap documented in MEMORY.md.
**Fix**: No action required for Phase 1 (already tracked). When MemoryAdapter is used beyond dev mode, add a cleanup step in the upsert path.

#### F-E3-R2-003: No GIN index on `packet` JSONB column for Postgres [severity: nit]
**File**: apps/receiver/src/storage/drizzle/postgres.ts:74-77
**Description**: `getIncidentByPacketId` queries `packet->>'packetId' = $1`. Without a GIN or expression index, this requires a sequential scan of the JSONB column. For the expected scale (dozens to low hundreds of incidents), this is fine. If scale grows, an expression index like `CREATE INDEX idx_incidents_packet_id ON incidents ((packet->>'packetId'))` would help.
**Fix**: No action needed for Phase 1. Consider adding if incident count exceeds ~1000.

#### F-E3-R2-004: `close()` and `execute()` still not on StorageDriver interface [severity: nit]
**File**: apps/receiver/src/storage/drizzle/postgres.ts:80-87
**Description**: Carried from round 1 (F-E3-006). `close()` is needed for Postgres connection pool cleanup and `execute()` is used for test TRUNCATE. Neither is on the `StorageDriver` interface. The Postgres test file correctly types `adapter` as `PostgresAdapter` (not `StorageDriver`), so this works. Still worth adding `close?(): Promise<void>` to the interface eventually, as any adapter with external connections needs lifecycle management.
**Fix**: Defer to Phase E or later. No functional impact.

### Verification notes

- **Tests**: `pnpm --filter @3amoncall/receiver test` — 109 passed, 1 skipped (Postgres, no DATABASE_URL locally). 0 failures.
- **Typecheck**: `pnpm --filter @3amoncall/receiver typecheck` — clean, no errors.
- **Drizzle jsonb() + onConflictDoUpdate**: Verified that Drizzle handles `set: { packet }` (where `packet` is a plain JS object) correctly for `jsonb()` columns — Drizzle calls `JSON.stringify` internally before sending to postgres.js. No double-encoding risk.
- **json_extract in SQLite**: Verified that `sql\`json_extract(${incidents.packet}, '$.packetId') = ${packetId}\`` correctly produces parameterized SQL. The column reference is interpolated as an identifier, the string literal `'$.packetId'` is embedded directly, and `packetId` is bound as a parameter.
- **Index creation order**: Both SQLite and Postgres run CREATE TABLE before CREATE INDEX in `migrate()`. SQLite's `migrate()` is called synchronously in the constructor, so the table is guaranteed to exist when the index DDL runs. Postgres's `migrate()` is async with sequential awaits — same guarantee.

### Overall verdict

**APPROVE** — All 9 fixes are technically correct and introduce no new problems. The remaining findings (R2-001 through R2-004) are nits or already-tracked deferrals with no functional impact. The code is ready to merge.
