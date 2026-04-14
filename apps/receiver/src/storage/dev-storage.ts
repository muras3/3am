/**
 * resolveDevStorage — selects SQLite storage for local dev mode.
 *
 * Extracted into its own module so it can be imported and tested
 * without triggering server.ts module-level side effects (main(), port bind).
 */
import { mkdirSync } from "fs";
import { join } from "path";
import { SQLiteAdapter } from "./drizzle/sqlite.js";
import type { StorageDriver } from "./interface.js";
import { emitSelfTelemetryLog } from "../self-telemetry/log.js";

/**
 * Returns a SQLiteAdapter backed by `.3am/dev.db` when running in dev mode,
 * or null if production (DATABASE_URL set) or dev mode is not enabled.
 *
 * @param env  - environment variable map (pass `process.env` in production)
 * @param cwd  - working directory for the `.3am/` directory (pass `process.cwd()`)
 */
export function resolveDevStorage(env: Record<string, string | undefined>, cwd: string): StorageDriver | null {
  if (env["DATABASE_URL"]) return null; // caller handles Postgres
  if (env["ALLOW_INSECURE_DEV_MODE"] !== "true") return null;

  const dbDir = join(cwd, ".3am");
  const dbPath = join(dbDir, "dev.db");
  try {
    mkdirSync(dbDir, { recursive: true });
    const adapter = new SQLiteAdapter(dbPath);
    emitSelfTelemetryLog({
      severity: "INFO",
      body: "[receiver] Using persistent SQLite storage at .3am/dev.db (delete to reset)",
    });
    return adapter;
  } catch (err) {
    emitSelfTelemetryLog({
      severity: "WARN",
      body: "[receiver] SQLite init failed — falling back to MemoryAdapter",
      attributes: { "error.message": err instanceof Error ? err.message : String(err) },
    });
    return null;
  }
}
