import { initializeNodeSelfTelemetry } from "./self-telemetry/node.js";
import { readFileSync } from "fs";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { join } from "path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp, resolveAuthToken, WsBridgeManager } from "./index.js";
import type { BridgeWsConnection } from "./transport/ws-bridge.js";
import { MemoryAdapter } from "./storage/adapters/memory.js";
import { createPostgresClient } from "./storage/drizzle/postgres-client.js";
import { PostgresAdapter } from "./storage/drizzle/postgres.js";
import { PostgresTelemetryAdapter } from "./telemetry/drizzle/postgres.js";
import { emitSelfTelemetryLog } from "./self-telemetry/log.js";
import { WebSocketServer } from "ws";

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
    const sharedClient = createPostgresClient();
    storage = new PostgresAdapter(sharedClient);
    await storage.migrate();

    telemetryStore = new PostgresTelemetryAdapter(sharedClient);
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
  const wsBridge = new WsBridgeManager();

  const app = createApp(storage, { telemetryStore, resolvedAuthToken, wsBridge });

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
  const server = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
    emitSelfTelemetryLog({
      severity: "INFO",
      body: "3am receiver listening",
      attributes: {
        "server.address": "0.0.0.0",
        "server.port": info.port,
      },
    });
  });

  // WebSocket upgrade for bridge connections (#331)
  const wss = new WebSocketServer({ noServer: true });
  // @hono/node-server's serve() returns ServerType which wraps http.Server
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname !== "/bridge/ws") {
      socket.destroy();
      return;
    }
    const queryToken = url.searchParams.get("token");
    if (resolvedAuthToken && queryToken !== resolvedAuthToken) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn: BridgeWsConnection = {
        send: (data) => ws.send(data),
        close: (code, reason) => ws.close(code, reason),
      };
      wsBridge.setConnection(conn);
      ws.on("message", (raw) => {
        const data = typeof raw === "string" ? raw : raw.toString("utf-8");
        wsBridge.handleMessage(data);
      });
      ws.on("close", () => wsBridge.removeConnection(conn));
      ws.on("error", () => wsBridge.removeConnection(conn));
      emitSelfTelemetryLog({
        severity: "INFO",
        body: "[receiver] bridge WebSocket connected",
      });
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
