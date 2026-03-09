/**
 * PostgresAdapter contract tests.
 *
 * Requires a running Postgres instance. Set DATABASE_URL before running:
 *   DATABASE_URL=postgres://... pnpm --filter @3amoncall/receiver test
 *
 * In CI this is provided by the GitHub Actions postgres service container.
 * Tests are skipped automatically when DATABASE_URL is not set.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { PostgresAdapter } from "../../storage/drizzle/postgres.js";
import { runStorageSuite } from "./shared-suite.js";

const DATABASE_URL = process.env["DATABASE_URL"];

if (!DATABASE_URL) {
  describe("PostgresAdapter", () => {
    it.skip("skipped — DATABASE_URL not set", () => {});
  });
} else {
  let adapter: PostgresAdapter;

  beforeAll(async () => {
    adapter = new PostgresAdapter(DATABASE_URL);
    await adapter.migrate();
  });

  afterAll(async () => {
    await adapter.close();
  });

  runStorageSuite("PostgresAdapter", () => adapter, {
    cleanup: async () => {
      // Truncate between each test for isolation (Postgres is a shared process)
      await adapter.execute(
        sql`TRUNCATE TABLE incidents, thin_events RESTART IDENTITY CASCADE`,
      );
    },
  });
}
