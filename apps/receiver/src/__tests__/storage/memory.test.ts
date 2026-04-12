/**
 * MemoryAdapter contract tests — migrated to shared suite (E3).
 *
 * Each test gets a fresh in-memory adapter via getDriver(), so no cleanup needed.
 */
import { MemoryAdapter } from "../../storage/adapters/memory.js";
import { runStorageSuite } from "./shared-suite.js";

runStorageSuite("MemoryAdapter", () => new MemoryAdapter());
