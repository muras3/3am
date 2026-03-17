/**
 * PostgresTelemetryAdapter contract tests.
 *
 * Requires a running Postgres instance. Set DATABASE_URL before running:
 *   DATABASE_URL=postgres://... pnpm --filter @3amoncall/receiver test
 *
 * In CI this is provided by the GitHub Actions postgres service container.
 * Tests are skipped automatically when DATABASE_URL is not set.
 */
import { describe, it, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { PostgresTelemetryAdapter } from "../../telemetry/drizzle/postgres.js";
import { runTelemetryStoreSuite } from "./shared-suite.js";

const DATABASE_URL = process.env["DATABASE_URL"];

if (!DATABASE_URL) {
  describe("PostgresTelemetryAdapter", () => {
    it.skip("skipped — DATABASE_URL not set", () => {});
  });
} else {
  let adapter: PostgresTelemetryAdapter;

  beforeAll(async () => {
    adapter = new PostgresTelemetryAdapter(DATABASE_URL);
    await adapter.migrate();
  });

  afterAll(async () => {
    await adapter.close();
  });

  runTelemetryStoreSuite("PostgresTelemetryAdapter", () => adapter, {
    cleanup: async () => {
      // Truncate between each test for isolation (Postgres is a shared process)
      await adapter.execute(
        sql`TRUNCATE TABLE telemetry_spans, telemetry_metrics, telemetry_logs, incident_evidence_snapshots`,
      );
    },
  });
}
