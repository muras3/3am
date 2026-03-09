## E3 Code Review — Round 1

### Summary

The E3 implementation delivers SQLiteAdapter and PostgresAdapter backed by Drizzle ORM, with a well-structured shared contract test suite (14 tests). The overall design is clean and ADR-compliant. However, there are several correctness issues around type mismatches between the Drizzle schema and DDL, a full table scan in SQLiteAdapter.getIncidentByPacketId, and a subtle upsert bug in the "upsert preserves diagnosisResult" test that masks a real Postgres problem.

### Findings

#### F-E3-001: Postgres DDL uses JSONB but Drizzle column definition is `text` — type mismatch [severity: major]
**File**: apps/receiver/src/storage/drizzle/postgres.ts:17-26
**Category**: correctness
**Description**: The `pgIncidents` table defines `packet` and `diagnosisResult` as `text()` columns in the Drizzle schema (lines 22-23), but the `migrate()` DDL (lines 58-59) creates them as `JSONB`. This mismatch means:
1. Drizzle will generate SQL treating these as TEXT columns, but Postgres stores them as JSONB.
2. When inserting via `JSON.stringify(packet)`, Postgres auto-casts the text to JSONB (which works), but on SELECT, Postgres returns a parsed JSON object, not a string. The `toIncident` method handles this with `typeof row.packet === "string"` branching (line 91), but this is a fragile workaround for a schema mismatch.
3. If Drizzle ever generates queries that assume TEXT semantics (e.g., LIKE, string concatenation), they will fail or produce unexpected results.
**Fix**: Use `jsonb()` from `drizzle-orm/pg-core` for `packet` and `diagnosisResult` columns, or change the DDL to use TEXT. The JSONB approach is better since `getIncidentByPacketId` already uses the `->>'packetId'` JSONB operator (line 173).

#### F-E3-002: getIncidentByPacketId in SQLiteAdapter does a full table scan [severity: major]
**File**: apps/receiver/src/storage/drizzle/sqlite.ts:138-146
**Category**: performance
**Description**: The method loads ALL rows into memory and iterates them in JS to find the matching packetId. The comment says "for production use an index on packet->>'packetId'" but the current implementation is O(n) in both memory and CPU. Even for small deployments, this is called on every diagnosis callback (GitHub Actions returning a result). With 100+ incidents, this becomes noticeable.
**Fix**: Use SQLite's JSON extract: `WHERE json_extract(packet, '$.packetId') = ?`. SQLite supports `json_extract` natively. Alternatively, add a `packet_id` column to the incidents table to avoid JSON parsing entirely. The latter is recommended since it also benefits Postgres and aligns with the fact that `packetId` is a first-class query target.

#### F-E3-003: Shared schema.ts is SQLite-only but comment claims "shared" [severity: minor]
**File**: apps/receiver/src/storage/drizzle/schema.ts:1-7
**Category**: correctness
**Description**: The file header says "shared between SQLiteAdapter and PostgresAdapter", but PostgresAdapter defines its own `pgIncidents` / `pgThinEvents` tables using `pgTable` in postgres.ts. The schema.ts file is only used by SQLiteAdapter. This is misleading documentation that could cause confusion during maintenance.
**Fix**: Update the comment to say "SQLite schema — used by SQLiteAdapter only. PostgresAdapter defines its own PG-specific schema."

#### F-E3-004: Upsert test does not verify packet update actually happened [severity: minor]
**File**: apps/receiver/src/__tests__/storage/shared-suite.ts:105-118
**Category**: test-coverage
**Description**: The upsert test (line 105) creates a packet, appends a diagnosis, then re-inserts with `packetId: "pkt_test_001_v2"`. It correctly checks that `diagnosisResult` is preserved, but does NOT assert that the packet was actually updated to the new version. Without this assertion, an adapter could silently ignore the upsert (no-op on conflict) and still pass.
**Fix**: Add: `expect(incident?.packet.packetId).toBe("pkt_test_001_v2");`

#### F-E3-005: Postgres `toIncident` casts `status` with `as` but no runtime validation [severity: minor]
**File**: apps/receiver/src/storage/drizzle/postgres.ts:89
**Category**: correctness
**Description**: `row.status as "open" | "closed"` is a TypeScript assertion that provides no runtime guarantee. If the database somehow contains an unexpected status value (e.g., from a manual UPDATE or migration), this would pass through undetected. The SQLite schema uses `{ enum: ["open", "closed"] }` which provides Drizzle-level enforcement, but the Postgres schema uses bare `text("status")`.
**Fix**: Add `{ enum: ["open", "closed"] as const }` to the Postgres column definition: `status: text("status", { enum: ["open", "closed"] }).notNull().default("open")`. This gives Drizzle type-level enforcement and makes the `as` cast unnecessary.

#### F-E3-006: `execute()` method exposed on PostgresAdapter is not on StorageDriver interface [severity: minor]
**File**: apps/receiver/src/storage/drizzle/postgres.ts:77-79
**Category**: correctness
**Description**: The `execute()` method is public and used by tests for TRUNCATE. This is fine pragmatically, but it means the Postgres test file depends on `PostgresAdapter` concrete type, not the `StorageDriver` interface. The `close()` method (line 83) has the same issue. Neither is part of the `StorageDriver` contract.
**Fix**: This is acceptable for Phase 1 but should be documented. Consider adding `close?(): Promise<void>` to StorageDriver as an optional lifecycle method, since any adapter with a connection pool needs cleanup.

#### F-E3-007: No index on `opened_at` for listIncidents ORDER BY [severity: minor]
**File**: apps/receiver/src/storage/drizzle/sqlite.ts:33-45 and postgres.ts:52-63
**Category**: performance
**Description**: `listIncidents` orders by `opened_at DESC`. Without an index, both SQLite and Postgres will do a full table scan + sort for every list call. For small scale this is fine, but an index would cost nothing and prevent issues at moderate scale.
**Fix**: Add `CREATE INDEX IF NOT EXISTS idx_incidents_opened_at ON incidents(opened_at DESC)` to both `migrate()` methods.

#### F-E3-008: SQLite test creates new adapter per test, which re-runs migrate() each time [severity: nit]
**File**: apps/receiver/src/__tests__/storage/sqlite.test.ts:5
**Category**: performance
**Description**: The factory `() => new SQLiteAdapter(":memory:")` creates a fresh in-memory DB per test, which is correct for isolation. Each `new SQLiteAdapter()` runs `migrate()` with `CREATE TABLE IF NOT EXISTS`. This is harmless but slightly wasteful. Not a real problem.
**Fix**: No action needed. This is the correct approach for test isolation.

#### F-E3-009: Postgres cleanup runs TRUNCATE before getDriver(), but getDriver() returns the same adapter [severity: nit]
**File**: apps/receiver/src/__tests__/storage/postgres.test.ts:33-38
**Category**: test-coverage
**Description**: The Postgres test uses `cleanup` to TRUNCATE between tests, then `getDriver()` returns the same `adapter` instance. This is correct — the adapter is stateless (just a Drizzle wrapper), so reusing it is fine. The `beforeAll` / `afterAll` lifecycle is clean. No issue here.
**Fix**: No action needed.

#### F-E3-010: Missing test — saveThinEvent with duplicate event_id should fail [severity: minor]
**File**: apps/receiver/src/__tests__/storage/shared-suite.ts
**Category**: test-coverage
**Description**: The `thin_events` table has `event_id TEXT NOT NULL UNIQUE`. The contract tests do not verify that inserting a duplicate `event_id` throws an error. This is a boundary condition that should be tested to ensure all adapters enforce uniqueness consistently.
**Fix**: Add a test:
```typescript
it("saveThinEvent throws on duplicate event_id", async () => {
  const e = makeThinEvent({ event_id: "evt_dup" });
  await driver.saveThinEvent(e);
  await expect(driver.saveThinEvent(e)).rejects.toThrow();
});
```

#### F-E3-011: Missing test — appendDiagnosis on non-existent incident is silently ignored [severity: minor]
**File**: apps/receiver/src/__tests__/storage/shared-suite.ts
**Category**: test-coverage
**Description**: The contract tests verify `updateIncidentStatus` on unknown ID is a no-op (line 151-153), but there is no equivalent test for `appendDiagnosis` on a non-existent incident. The MemoryAdapter silently returns (line 42-43 of memory.ts). The Drizzle adapters do an UPDATE WHERE which matches zero rows — also silent. This behavior should be explicitly tested and documented.
**Fix**: Add a test:
```typescript
it("appendDiagnosis is a no-op for unknown incidentId", async () => {
  const dr = makeDiagnosis("inc_unknown", "pkt_unknown");
  await expect(driver.appendDiagnosis("inc_unknown", dr)).resolves.toBeUndefined();
});
```

#### F-E3-012: MemoryAdapter.createIncident does not update packetIndex on upsert for old packetId [severity: minor]
**File**: apps/receiver/src/storage/adapters/memory.ts:10-26
**Category**: correctness
**Description**: When `createIncident` upserts an existing incident with a new packet (which may have a different `packetId`), the old `packetId` remains in `packetIndex` as a stale entry (line 25 only adds the new one). This means `getIncidentByPacketId(oldPacketId)` still returns the incident. This is noted in MEMORY.md as a known issue ("packetIndex: upsert 時に古い packetId が残る"), but the Drizzle adapters do NOT have this problem — SQLiteAdapter does a full scan, and PostgresAdapter queries the live JSON. This behavioral divergence across adapters is a contract gap.
**Fix**: Either clean up stale entries in MemoryAdapter's upsert path, or document this as a known behavioral difference. Since the contract test (F-E3-004) doesn't assert on the old packetId post-upsert, this doesn't cause test failures but could cause bugs in production with MemoryAdapter.

#### F-E3-013: `updatedAt` trigger missing — UPDATE does not auto-refresh `updated_at` [severity: nit]
**File**: apps/receiver/src/storage/drizzle/sqlite.ts:42 and postgres.ts:61
**Category**: correctness
**Description**: Both DDLs set `updated_at` default to `now()` / `strftime(...)`, but these defaults only apply on INSERT. The adapters manually set `updatedAt` in every UPDATE call, so this works correctly. However, if anyone ever uses raw SQL to update rows, `updated_at` won't auto-refresh. A trigger would be more robust but is not needed for Phase 1.
**Fix**: No action needed for Phase 1. Consider adding a trigger if raw SQL access becomes a pattern.

#### F-E3-014: CI does not run `db:migrate` before tests [severity: minor]
**File**: .github/workflows/ci.yml:77-81
**Category**: correctness
**Description**: The CI config sets `DATABASE_URL` and runs receiver tests, but does not explicitly run `pnpm --filter @3amoncall/receiver db:migrate` before tests. The Postgres test file calls `adapter.migrate()` in `beforeAll()` (postgres.test.ts:26), so this works. However, if future tests depend on the database schema existing without calling `migrate()` themselves, they will fail. The current approach is acceptable but fragile.
**Fix**: Consider adding a `db:migrate` step in CI before the receiver test step, as defense in depth. Or document that each test file must call `migrate()` in its setup.

#### F-E3-015: `pg_isready` healthcheck in CI does not specify `-U receiver` [severity: nit]
**File**: .github/workflows/ci.yml:29
**Category**: correctness
**Description**: The CI Postgres service uses `--health-cmd pg_isready` without `-U receiver`. The docker-compose.dev.yml (line 12) uses `pg_isready -U receiver`. Without `-U`, `pg_isready` defaults to the current OS user, which may not match. In practice, `pg_isready` just checks if the server accepts connections regardless of the user, so this works — but it's inconsistent with docker-compose.dev.yml.
**Fix**: Change to `--health-cmd "pg_isready -U receiver"` for consistency.

#### F-E3-016: Postgres packet column stores stringified JSON in JSONB — double encoding risk [severity: major]
**File**: apps/receiver/src/storage/drizzle/postgres.ts:111
**Category**: correctness
**Description**: `createIncident` calls `JSON.stringify(packet)` and inserts it into a JSONB column. When postgres.js sends a string to a JSONB column, Postgres parses it as JSON — so it works. But if Drizzle or postgres.js ever changes to wrap the value in quotes (treating it as a JSON string literal), you'd get double-encoded JSON: `"\"{\\"incidentId\\"...}\""`. The `toIncident` method's `typeof row.packet === "string"` check (line 91) is a defensive guard against this, suggesting the author was aware of the risk. This is tightly coupled to postgres.js driver behavior.
**Fix**: This is directly related to F-E3-001. Using Drizzle's `jsonb()` column type would make the serialization behavior explicit and driver-independent.

### Overall verdict

**REQUEST CHANGES** — Three major findings need resolution before merge: (1) the JSONB/text schema mismatch in PostgresAdapter that creates fragile runtime behavior, (2) the full-table-scan `getIncidentByPacketId` in SQLiteAdapter, and (3) the upsert test not verifying the packet was actually updated. The remaining findings are minor or nits that can be addressed incrementally.
