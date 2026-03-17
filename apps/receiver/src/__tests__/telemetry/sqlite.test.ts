/**
 * SQLiteTelemetryAdapter contract tests.
 *
 * Each test gets a fresh in-memory database via the factory function.
 */
import { SQLiteTelemetryAdapter } from "../../telemetry/drizzle/sqlite.js";
import { runTelemetryStoreSuite } from "./shared-suite.js";

runTelemetryStoreSuite("SQLiteTelemetryAdapter", () => new SQLiteTelemetryAdapter(":memory:"));
