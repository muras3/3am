const http = require("http");
const fs = require("fs");
const { URL } = require("url");
const { trace, SpanStatusCode } = require("@opentelemetry/api");
const { NodeSDK } = require("@opentelemetry/sdk-node");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");

const port = Number(process.env.PORT || 7001);
const appLogFile = process.env.APP_LOG_FILE || "";
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://otel-collector:4318";
const DEFAULT_LATENCY_MS = Number(process.env.DEFAULT_LATENCY_MS || 100);
const SLOW_LATENCY_MS = Number(process.env.SLOW_LATENCY_MS || 8000);

let logStream = null;
const state = {
  mode: "normal",
  latencyMs: DEFAULT_LATENCY_MS,
  slowLatencyMs: SLOW_LATENCY_MS
};

function log(message, fields = {}) {
  const payload = { ts: new Date().toISOString(), message, ...fields };
  process.stdout.write(JSON.stringify(payload) + "\n");
  if (logStream) {
    logStream.write(JSON.stringify(payload) + "\n");
  }
}

if (appLogFile) {
  fs.mkdirSync(require("path").dirname(appLogFile), { recursive: true });
  logStream = fs.createWriteStream(appLogFile, { flags: "a" });
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let tracer;

async function main() {
  if (appLogFile) {
    fs.mkdirSync(require("path").dirname(appLogFile), { recursive: true });
  }

  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` })
  });
  await sdk.start();
  tracer = trace.getTracer("mock-notification-svc");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/__admin/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/__admin/state") {
      sendJson(res, 200, state);
      return;
    }

    if (req.method === "POST" && url.pathname === "/__admin/mode") {
      try {
        const body = await readJson(req);
        if (body.mode) {
          state.mode = body.mode;
        }
        if (body.config && typeof body.config.slow_latency_ms === "number") {
          state.slowLatencyMs = body.config.slow_latency_ms;
        }
        log("notification-svc mode changed", { mode: state.mode, slowLatencyMs: state.slowLatencyMs });
        sendJson(res, 200, state);
      } catch (error) {
        sendJson(res, 400, { error: "invalid json body" });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/__admin/reset") {
      state.mode = "normal";
      state.latencyMs = DEFAULT_LATENCY_MS;
      state.slowLatencyMs = SLOW_LATENCY_MS;
      log("notification-svc reset", { mode: state.mode });
      sendJson(res, 200, state);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/notify") {
      let body = {};
      try {
        body = await readJson(req);
      } catch (error) {
        sendJson(res, 400, { error: "invalid json body" });
        return;
      }

      await tracer.startActiveSpan("notification.call", async (span) => {
        const actualWait = state.mode === "slow" ? state.slowLatencyMs : state.latencyMs;
        span.setAttributes({
          "notification.latency_ms": actualWait,
          "notification.mode": state.mode,
          "notification.order_id": body.orderId || ""
        });

        await sleep(actualWait);

        log("notification sent", {
          mode: state.mode,
          latencyMs: actualWait,
          orderId: body.orderId || ""
        });

        span.end();
        sendJson(res, 200, { ok: true, provider: "mock-notification-svc" });
      });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  });

  server.listen(port, () => {
    log("mock-notification-svc started", { port });
  });

  process.on("SIGTERM", async () => {
    if (logStream) {
      logStream.end();
    }
    await sdk.shutdown();
    process.exit(0);
  });
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
