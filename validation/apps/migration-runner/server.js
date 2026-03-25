const http = require("http");
const { Client } = require("pg");
const { trace, SpanStatusCode } = require("@opentelemetry/api");
const { logs } = require("@opentelemetry/api-logs");
const { NodeSDK } = require("@opentelemetry/sdk-node");
const { BatchLogRecordProcessor } = require("@opentelemetry/sdk-logs");
const { OTLPLogExporter } = require("@opentelemetry/exporter-logs-otlp-http");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");

const port = Number(process.env.PORT || 5001);
const databaseUrl = process.env.DATABASE_URL || "postgres://validation:validation@postgres:5432/validation";
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://otel-collector:4318";
const lockHoldSec = Number(process.env.LOCK_HOLD_SEC || 10);
const appLogFile = process.env.APP_LOG_FILE || "";

let logStream = null;
let tracer;
let otelLogger;

const state = {
  phase: "idle",
  connectionA_pid: null,
  connectionB_pid: null,
  lockHoldStartedAt: null,
  alterStartedAt: null,
  exclusiveLockStartedAt: null,
  doneAt: null,
  clientA: null,
  clientB: null,
  readerHoldSec: null,
  migrationHoldSec: null
};

function log(message, fields = {}, level = "info") {
  const payload = { ts: new Date().toISOString(), level, message, ...fields };
  process.stdout.write(JSON.stringify(payload) + "\n");
  if (logStream) {
    logStream.write(JSON.stringify(payload) + "\n");
  }
  if (otelLogger) {
    const severityNumber = { trace: 1, debug: 5, info: 9, warn: 13, error: 17, fatal: 21 }[level] ?? 0;
    otelLogger.emit({ severityNumber, severityText: level.toUpperCase(), body: message, attributes: fields });
  }
}

function attachClientErrorHandler(client, label) {
  client.on("error", (err) => {
    if (err && (err.code === "57P01" || err.message === "Connection terminated unexpectedly")) {
      log("client terminated during reset", { label, code: err.code || "unknown" });
      return;
    }
    log("client error", { label, error: err.message, code: err.code || "unknown" });
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = chunks.length ? Buffer.concat(chunks).toString("utf8") : "{}";
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function ensureOrdersTable() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending',
        amount INTEGER NOT NULL DEFAULT 1999,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const countResult = await client.query("SELECT COUNT(*) AS cnt FROM orders");
    if (Number(countResult.rows[0].cnt) === 0) {
      await client.query(`
        INSERT INTO orders (status, amount, created_at)
        SELECT
          CASE WHEN random() < 0.7 THEN 'completed' ELSE 'pending' END,
          1999,
          NOW() - (random() * interval '7 days')
        FROM generate_series(1, 100)
      `);
    }
  } finally {
    await client.end();
  }
}

async function startMigration(config = {}) {
  if (state.phase !== "idle") {
    throw new Error(`cannot start: current phase is ${state.phase}`);
  }

  const readerHoldSec = Number(config.reader_hold_sec || config.lock_hold_sec || lockHoldSec);
  const migrationHoldSec = Number(config.migration_hold_sec || config.exclusive_lock_hold_sec || readerHoldSec);
  const alterStartDelayMs = Number(config.alter_start_delay_ms || 1000);
  state.phase = "locking";
  state.readerHoldSec = readerHoldSec;
  state.migrationHoldSec = migrationHoldSec;

  const lockHoldSpan = tracer.startSpan("migration.lock_hold", {
    attributes: { "db.system.name": "postgresql", "db.operation": "select" }
  });

  // Connection A: long-running SELECT that holds AccessShareLock
  state.clientA = new Client({ connectionString: databaseUrl });
  attachClientErrorHandler(state.clientA, "clientA");
  await state.clientA.connect();
  const pidResultA = await state.clientA.query("SELECT pg_backend_pid() AS pid");
  state.connectionA_pid = pidResultA.rows[0].pid;
  await state.clientA.query("BEGIN");
  state.lockHoldStartedAt = new Date().toISOString();
  log("analytics query started", { pid: state.connectionA_pid, readerHoldSec }, "warn");

  state.clientA.query("LOCK TABLE orders IN ACCESS SHARE MODE").then(async () => {
    await state.clientA.query("SELECT pg_sleep($1)", [readerHoldSec]);
    await state.clientA.query("COMMIT");
    await state.clientA.end();
    state.clientA = null;
    lockHoldSpan.end();
    log("analytics query committed");
  }).catch((err) => {
    log("analytics query error", { error: err.message });
    lockHoldSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    lockHoldSpan.end();
  });

  setTimeout(async () => {
    try {
      state.phase = "migration_waiting";

      const alterSpan = tracer.startSpan("migration.alter_table", {
        attributes: {
          "db.system.name": "postgresql",
          "db.operation": "alter_table",
          "db.sql.table": "orders"
        }
      });

      // Connection B: ALTER TABLE — will block waiting for AccessExclusiveLock
      state.clientB = new Client({ connectionString: databaseUrl });
      attachClientErrorHandler(state.clientB, "clientB");
      await state.clientB.connect();
      const pidResultB = await state.clientB.query("SELECT pg_backend_pid() AS pid");
      state.connectionB_pid = pidResultB.rows[0].pid;
      state.alterStartedAt = new Date().toISOString();
      log("migration started", { pid: state.connectionB_pid, migrationHoldSec }, "warn");

      await state.clientB.query("BEGIN");
      await state.clientB.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 0");
      state.phase = "exclusive_lock_held";
      state.exclusiveLockStartedAt = new Date().toISOString();
      log("migration exclusive lock acquired", { pid: state.connectionB_pid, migrationHoldSec }, "warn");
      await state.clientB.query("SELECT pg_sleep($1)", [migrationHoldSec]);
      await state.clientB.query("COMMIT");
      await state.clientB.end();
      state.clientB = null;
      alterSpan.end();

      state.phase = "done";
      state.doneAt = new Date().toISOString();
      log("migration completed");
    } catch (err) {
      log("migration error", { error: err.message });
      state.phase = "done";
      state.doneAt = new Date().toISOString();
    }
  }, alterStartDelayMs);
}

async function resetState() {
  // Cancel active connections
  const cancelClient = new Client({ connectionString: databaseUrl });
  await cancelClient.connect();
  try {
    for (const pid of [state.connectionA_pid, state.connectionB_pid]) {
      if (pid) {
        try {
          await cancelClient.query("SELECT pg_cancel_backend($1)", [pid]);
        } catch (err) {
          // ignore
        }
      }
    }

    // Poll pg_stat_activity until both PIDs are gone
    const pids = [state.connectionA_pid, state.connectionB_pid].filter(Boolean);
    if (pids.length > 0) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const result = await cancelClient.query(
          "SELECT pid FROM pg_stat_activity WHERE pid = ANY($1)",
          [pids]
        );
        if (result.rows.length === 0) break;
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    // Clean up connections
    if (state.clientA) {
      try { await state.clientA.end(); } catch (err) { /* ignore */ }
    }
    if (state.clientB) {
      try { await state.clientB.end(); } catch (err) { /* ignore */ }
    }

    // Drop the added column
    await cancelClient.query("ALTER TABLE orders DROP COLUMN IF EXISTS priority");
  } finally {
    await cancelClient.end();
  }

  await ensureOrdersTable();

  state.phase = "idle";
  state.connectionA_pid = null;
  state.connectionB_pid = null;
  state.lockHoldStartedAt = null;
  state.alterStartedAt = null;
  state.exclusiveLockStartedAt = null;
  state.doneAt = null;
  state.clientA = null;
  state.clientB = null;
  state.readerHoldSec = null;
  state.migrationHoldSec = null;
  log("migration-runner reset");
}

async function main() {
  if (appLogFile) {
    const fs = require("fs");
    const path = require("path");
    fs.mkdirSync(path.dirname(appLogFile), { recursive: true });
    logStream = fs.createWriteStream(appLogFile, { flags: "a" });
  }

  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` }),
    logRecordProcessor: new BatchLogRecordProcessor(new OTLPLogExporter({ url: `${otlpEndpoint}/v1/logs` }))
  });
  await sdk.start();
  tracer = trace.getTracer("migration-runner");
  otelLogger = logs.getLogger("migration-runner");

  // Ensure orders table exists with seed data
  await ensureOrdersTable();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/__admin/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/__admin/state") {
      sendJson(res, 200, {
        state: state.phase,
        connectionA_pid: state.connectionA_pid,
        connectionB_pid: state.connectionB_pid,
        lockHoldStartedAt: state.lockHoldStartedAt,
        alterStartedAt: state.alterStartedAt,
        exclusiveLockStartedAt: state.exclusiveLockStartedAt,
        readerHoldSec: state.readerHoldSec,
        migrationHoldSec: state.migrationHoldSec,
        doneAt: state.doneAt
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/__admin/start") {
      try {
        const body = await readJson(req);
        await startMigration(body);
        sendJson(res, 200, { ok: true, state: state.phase });
      } catch (err) {
        sendJson(res, 409, { error: err.message });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/__admin/reset") {
      try {
        await resetState();
        sendJson(res, 200, { state: "idle" });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    sendJson(res, 404, { error: "not found" });
  });

  server.listen(port, () => {
    log("migration-runner started", { port });
  });

  process.on("SIGTERM", async () => {
    if (logStream) logStream.end();
    await sdk.shutdown();
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});
