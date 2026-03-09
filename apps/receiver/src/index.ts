import { readFileSync } from "fs";
import { join } from "path";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { serveStatic } from "@hono/node-server/serve-static";
import type { StorageDriver } from "./storage/interface.js";
import { MemoryAdapter } from "./storage/adapters/memory.js";
import { createIngestRouter } from "./transport/ingest.js";
import { createApiRouter } from "./transport/api.js";

export type { StorageDriver } from "./storage/interface.js";
export type { Incident, IncidentPage } from "./storage/interface.js";
export { MemoryAdapter } from "./storage/adapters/memory.js";

export interface AppOptions {
  /** Absolute path to the built Console dist directory. When set, Receiver serves
   *  the SPA at "/" and falls back to index.html for unknown paths.
   *  Can also be set via CONSOLE_DIST_PATH env var.
   */
  consoleDist?: string;
}

export function createApp(storage?: StorageDriver, options?: AppOptions): Hono {
  const store = storage ?? new MemoryAdapter();
  const app = new Hono();
  const authToken = process.env["RECEIVER_AUTH_TOKEN"];

  if (!authToken) {
    const allowInsecure = process.env["ALLOW_INSECURE_DEV_MODE"] === "true";
    if (!allowInsecure) {
      throw new Error(
        "[receiver] RECEIVER_AUTH_TOKEN must be set. " +
          "For local dev only, set ALLOW_INSECURE_DEV_MODE=true (ADR 0011)",
      );
    }
    console.warn("[receiver] auth disabled — ALLOW_INSECURE_DEV_MODE=true (dev only, ADR 0011)");
  } else {
    // Auth is scoped by caller type (ADR 0028):
    // - /v1/*           → OTel SDK ingest — requires Bearer token
    // - /api/diagnosis/* → GitHub Actions callback — requires Bearer token
    // - /api/* (other)  → Console SPA (same-origin) — no Bearer required
    app.use("/v1/*", bearerAuth({ token: authToken }));
    app.use("/api/diagnosis/*", bearerAuth({ token: authToken }));
  }

  app.route("/", createIngestRouter(store));
  app.route("/", createApiRouter(store));

  // Static serving for the Console SPA (ADR 0028)
  const consoleDist = options?.consoleDist ?? process.env["CONSOLE_DIST_PATH"];
  if (consoleDist) {
    // Serve static assets (JS, CSS, images) by path
    app.use("/*", serveStatic({ root: consoleDist }));
    // SPA fallback: unknown paths → index.html (client-side routing)
    app.get("/*", (c) => {
      try {
        const html = readFileSync(join(consoleDist, "index.html"), "utf-8");
        return c.html(html);
      } catch {
        return c.text("Console not built. Run: pnpm --filter @3amoncall/console build", 503);
      }
    });
  }

  return app;
}
