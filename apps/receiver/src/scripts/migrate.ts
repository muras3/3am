/**
 * Run DDL migrations for the PostgresAdapter.
 *
 * Usage:
 *   DATABASE_URL=postgres://receiver:receiver@localhost:5432/receiver pnpm --filter @3am/receiver db:migrate
 */
import { PostgresAdapter } from "../storage/drizzle/postgres.js";

const adapter = new PostgresAdapter();
await adapter.migrate();
await adapter.close();
console.log("[migrate] done");
