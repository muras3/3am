import { serve } from "@hono/node-server";
import { createApp } from "./index.js";
import { PostgresAdapter } from "./storage/drizzle/postgres.js";

const port = Number(process.env.PORT ?? 4318);

// Run migrate() on every startup. This is safe because migrate() uses
// CREATE TABLE IF NOT EXISTS (idempotent DDL). For single-instance deploys
// this is fine; PostgreSQL DDL locks protect concurrent multi-instance starts.
// If future migrations require data transforms, move them to a pre-deploy step.
async function main() {
  let storage: PostgresAdapter | undefined;

  if (process.env["DATABASE_URL"]) {
    console.log("[receiver] DATABASE_URL detected — using PostgresAdapter");
    storage = new PostgresAdapter();
    await storage.migrate();
    console.log("[receiver] database migration complete");
  } else {
    console.warn(
      "[receiver] DATABASE_URL not set — using MemoryAdapter (data is not persisted)",
    );
  }

  const app = createApp(storage);

  // Bind to 0.0.0.0 so the server is reachable from outside the process
  // (containers, VMs, any hosted environment).
  serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
    console.log(`3amoncall receiver listening on http://0.0.0.0:${info.port}`);
  });
}

main().catch((err) => {
  console.error("[receiver] startup failed:", err);
  process.exit(1);
});
