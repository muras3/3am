import { SQLiteAdapter } from "../../storage/drizzle/sqlite.js";
import { runStorageSuite } from "./shared-suite.js";

// Each test gets a fresh in-memory database via the factory function
runStorageSuite("SQLiteAdapter", () => new SQLiteAdapter(":memory:"));
