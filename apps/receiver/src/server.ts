import { initializeNodeSelfTelemetry } from "./self-telemetry/node.js";
import { readFileSync } from "fs";
import { join } from "path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp, resolveAuthToken } from "./index.js";
import { MemoryAdapter } from "./storage/adapters/memory.js";
import { PostgresAdapter } from "./storage/drizzle/postgres.js";
import { PostgresTelemetryAdapter } from "./telemetry/drizzle/postgres.js";
import { emitSelfTelemetryLog } from "./self-telemetry/log.js";

const port = Number(process.env.PORT ?? 4318);

void initializeNodeSelfTelemetry("node");

// Run migrate() on every startup. This is safe because migrate() uses
// CREATE TABLE IF NOT EXISTS (idempotent DDL). For single-instance deploys
// this is fine; PostgreSQL DDL locks protect concurrent multi-instance starts.
// If future migrations require data transforms, move them to a pre-deploy step.
async function main() {
  let storage: PostgresAdapter | undefined;
  let telemetryStore: PostgresTelemetryAdapter | undefined;

  if (process.env["DATABASE_URL"]) {
    emitSelfTelemetryLog({
      severity: "INFO",
      body: "[receiver] DATABASE_URL detected — using PostgresAdapter",
    });
    storage = new PostgresAdapter();
    await storage.migrate();

    telemetryStore = new PostgresTelemetryAdapter();
    await telemetryStore.migrate();
    emitSelfTelemetryLog({
      severity: "INFO",
      body: "[receiver] database migration complete (incidents + telemetry)",
    });
  } else {
    emitSelfTelemetryLog({
      severity: "WARN",
      body: "[receiver] DATABASE_URL not set — using MemoryAdapter (data is not persisted)",
    });
  }

  // resolveAuthToken needs a StorageDriver even for MemoryAdapter, so that
  // env-var token is picked up when DATABASE_URL is not set (e.g. E2E tests).
  const storageForAuth = storage ?? new MemoryAdapter();
  const resolvedAuthToken = await resolveAuthToken(storageForAuth);

  const app = createApp(storage, { telemetryStore, resolvedAuthToken });

  // Static serving for the Console SPA (ADR 0028) — Node.js only
  const consoleDist = process.env["CONSOLE_DIST_PATH"];
  if (consoleDist) {
    let indexHtml: string | null = null;
    try {
      indexHtml = readFileSync(join(consoleDist, "index.html"), "utf-8");
    } catch {
      emitSelfTelemetryLog({
        severity: "WARN",
        body: "[receiver] Console index.html not found — SPA fallback disabled",
        attributes: { "console.dist_path": consoleDist },
      });
    }
    app.use("/*", serveStatic({ root: consoleDist }));
    if (indexHtml) {
      app.get("/*", (c) => c.html(indexHtml as string));
    }
  }

  // Bind to 0.0.0.0 so the server is reachable from outside the process
  // (containers, VMs, any hosted environment).
  serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
    emitSelfTelemetryLog({
      severity: "INFO",
      body: "3am receiver listening",
      attributes: {
        "server.address": "0.0.0.0",
        "server.port": info.port,
      },
    });
  });
}

main().catch((err) => {
  emitSelfTelemetryLog({
    severity: "ERROR",
    body: "[receiver] startup failed",
    attributes: {
      "error.message": err instanceof Error ? err.message : String(err),
    },
  });
  process.exit(1);
});
