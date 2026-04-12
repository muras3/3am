const http = require("http");
const fs = require("fs");
const { URL } = require("url");
const { trace, SpanKind, SpanStatusCode } = require("@opentelemetry/api");
const { logs } = require("@opentelemetry/api-logs");
const { NodeSDK } = require("@opentelemetry/sdk-node");
const { BatchLogRecordProcessor } = require("@opentelemetry/sdk-logs");
const { OTLPLogExporter } = require("@opentelemetry/exporter-logs-otlp-http");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");

const port = Number(process.env.PORT || 6001);
const appLogFile = process.env.APP_LOG_FILE || "";
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://otel-collector:4318";
const KEY_V1 = process.env.KEY_V1 || "key_v1";
const KEY_V2 = process.env.KEY_V2 || "key_v2";

let logStream = null;
const state = {
  valid_keys: new Set([KEY_V1, KEY_V2]),
  revoked_keys: new Set(),
  request_count: 0,
  auth_failures: 0
};

let otelLogger;

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
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` }),
    logRecordProcessor: new BatchLogRecordProcessor(new OTLPLogExporter({ url: `${otlpEndpoint}/v1/logs` }))
  });
  await sdk.start();
  tracer = trace.getTracer("mock-sendgrid");
  otelLogger = logs.getLogger("mock-sendgrid");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/__admin/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/__admin/state") {
      sendJson(res, 200, {
        valid_keys: [...state.valid_keys],
        revoked_keys: [...state.revoked_keys],
        request_count: state.request_count,
        auth_failures: state.auth_failures
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/__admin/revoke") {
      try {
        const body = await readJson(req);
        const key = body.key;
        if (key && state.valid_keys.has(key)) {
          state.valid_keys.delete(key);
          state.revoked_keys.add(key);
          log("key revoked", { key_prefix: key.slice(0, 8) });
          sendJson(res, 200, { revoked: true });
        } else {
          sendJson(res, 200, { revoked: false, reason: "key not in valid_keys" });
        }
      } catch (error) {
        sendJson(res, 400, { error: "invalid json body" });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/__admin/reset") {
      state.valid_keys = new Set([KEY_V1, KEY_V2]);
      state.revoked_keys = new Set();
      state.request_count = 0;
      state.auth_failures = 0;
      log("mock-sendgrid reset");
      sendJson(res, 200, { reset: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v3/mail/send") {
      await tracer.startActiveSpan("sendgrid.send", { kind: SpanKind.SERVER }, async (span) => {
        try {
          const authHeader = req.headers["authorization"] || "";
          const key = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
          state.request_count += 1;

          if (state.valid_keys.has(key)) {
            await sleep(80);
            span.setAttributes({
              "http.response.status_code": 202,
              "sendgrid.key_revoked": false,
              "sendgrid.provider": "mock-sendgrid"
            });
            log("sendgrid request", { key_prefix: key.slice(0, 8), status_code: 202 });
            sendJson(res, 202, { message: "success", provider: "mock-sendgrid" });
          } else if (state.revoked_keys.has(key)) {
            state.auth_failures += 1;
            await sleep(200);
            span.setAttributes({
              "http.response.status_code": 401,
              "sendgrid.key_revoked": true,
              "sendgrid.provider": "mock-sendgrid"
            });
            span.setStatus({ code: SpanStatusCode.ERROR, message: "authorization revoked" });
            log("sendgrid auth failure", { key_prefix: key.slice(0, 8), status_code: 401 }, "error");
            sendJson(res, 401, {
              errors: [{
                message: "The provided authorization grant is invalid, expired, or revoked",
                field: "authorization"
              }]
            });
          } else {
            span.setAttributes({
              "http.response.status_code": 403,
              "sendgrid.key_revoked": false,
              "sendgrid.provider": "mock-sendgrid"
            });
            span.setStatus({ code: SpanStatusCode.ERROR, message: "forbidden" });
            log("sendgrid auth failure", { key_prefix: key.slice(0, 8), status_code: 403 }, "error");
            sendJson(res, 403, { error: "forbidden" });
          }
        } finally {
          span.end();
        }
      });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  });

  server.listen(port, () => {
    log("mock-sendgrid started", { port });
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
