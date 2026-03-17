/**
 * MemoryTelemetryAdapter contract tests.
 *
 * Each test gets a fresh in-memory adapter via getDriver(), so no cleanup needed.
 */
import { MemoryTelemetryAdapter } from "../../telemetry/adapters/memory.js";
import { runTelemetryStoreSuite } from "./shared-suite.js";

runTelemetryStoreSuite("MemoryTelemetryAdapter", () => new MemoryTelemetryAdapter());
