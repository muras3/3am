const http = require("http");
const net = require("net");
const fs = require("fs");
const { URL } = require("url");
const { trace, metrics, SpanStatusCode } = require("@opentelemetry/api");
const { NodeSDK } = require("@opentelemetry/sdk-node");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { OTLPMetricExporter } = require("@opentelemetry/exporter-metrics-otlp-http");
const { PeriodicExportingMetricReader } = require("@opentelemetry/sdk-metrics");

const { handleCheckout } = require("./routes/checkout");
const { handleOrder } = require("./routes/orders");
const { handleHealth, handleMetrics } = require("./routes/health");
const { handleDbRecentOrders } = require("./routes/db");
const { handleNotificationsSend } = require("./routes/notifications");
const { handleApiOrders } = require("./routes/api-orders");

const port = Number(process.env.PORT || 3000);
const paymentBaseUrl = process.env.PAYMENT_BASE_URL || "http://mock-stripe:4000";
const dbHost = process.env.DATABASE_HOST || "postgres";
const dbPort = Number(process.env.DATABASE_PORT || 5432);
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://otel-collector:4318";
const appLogFile = process.env.APP_LOG_FILE || "";
const checkoutConcurrency = Number(process.env.CHECKOUT_CONCURRENCY || 16);
const checkoutTimeoutMs = Number(process.env.CHECKOUT_TIMEOUT_MS || 30000);
const orderTimeoutMs = Number(process.env.ORDER_TIMEOUT_MS || 50);
const orderQueueFailThreshold = Number(process.env.ORDER_QUEUE_FAIL_THRESHOLD || 25);
const retryMaxAttempts = Number(process.env.RETRY_MAX_ATTEMPTS || 5);
const retryIntervalMs = Number(process.env.RETRY_INTERVAL_MS || 100);
const retryBackoffMode = process.env.RETRY_BACKOFF_MODE || "fixed";

const state = {
  orders: new Map(),
  activeWorkers: 0,
  queue: [],
  nextOrderId: 1,
  logStream: null,
  currentRunId: "boot",
  stats: {
    checkoutRequests: 0,
    checkoutSuccesses: 0,
    checkoutFailures: 0,
    orderRequests: 0,
    orderFailures: 0,
    payment429s: 0,
    paymentRequests: 0,
    route504s: 0,
    dbConnectionCount: 0,
    retries: 0
  }
};

let tracer;
let meter;
let checkoutRequestCounter;
let checkoutFailureCounter;
let orderRequestCounter;
let orderFailureCounter;
let payment429Counter;
let retryCounter;
let route504Counter;
let checkoutDuration;
let paymentDuration;
let orderDuration;

function runAttrs(attrs = {}) {
  return {
    ...attrs,
    "validation.run_id": state.currentRunId
  };
}

function ensureLogDir(logFile) {
  if (!logFile) {
    return;
  }
  fs.mkdirSync(require("path").dirname(logFile), { recursive: true });
}

function initLogStream(logFile) {
  if (!logFile) {
    return null;
  }
  ensureLogDir(logFile);
  return fs.createWriteStream(logFile, { flags: "a" });
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders
  });
  res.end(body);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(level, message, fields = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    runId: state.currentRunId,
    ...fields
  };
  process.stdout.write(JSON.stringify(payload) + "\n");
  if (state.logStream) {
    state.logStream.write(JSON.stringify(payload) + "\n");
  }
}

function observeDbConnection() {
  const socket = net.createConnection({ host: dbHost, port: dbPort });
  socket.on("connect", () => {
    state.stats.dbConnectionCount += 1;
    setTimeout(() => socket.end(), 50);
  });
  socket.on("error", () => {});
}

setInterval(observeDbConnection, 2000);

function enqueueWork(task, timeoutMs) {
  return new Promise((resolve, reject) => {
    const enqueuedAt = Date.now();
    let settled = false;
    const wrapped = async () => {
      const queueWaitMs = Date.now() - enqueuedAt;
      try {
        const result = await task(queueWaitMs);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(result);
        }
      } catch (error) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      } finally {
        state.activeWorkers -= 1;
        drainQueue();
      }
    };
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      const queuedIndex = state.queue.indexOf(wrapped);
      if (queuedIndex !== -1) {
        state.queue.splice(queuedIndex, 1);
      }
      reject(Object.assign(new Error("worker pool queue timed out"), { statusCode: 504 }));
    }, timeoutMs);
    state.queue.push(wrapped);
    drainQueue();
  });
}

function drainQueue() {
  while (state.activeWorkers < checkoutConcurrency && state.queue.length > 0) {
    const task = state.queue.shift();
    state.activeWorkers += 1;
    task();
  }
}

function requestJson(method, urlString, body) {
  const url = new URL(urlString);
  const payload = body ? JSON.stringify(body) : "";
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload)
        }
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed = {};
          if (raw) {
            try {
              parsed = JSON.parse(raw);
            } catch (error) {
              parsed = { raw };
            }
          }
          resolve({
            statusCode: res.statusCode || 500,
            headers: res.headers,
            body: parsed
          });
        });
      }
    );
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function callPayment(orderId) {
  return tracer.startActiveSpan("payment.charge", async (span) => {
    let attempt = 0;
    try {
      for (;;) {
        attempt += 1;
        state.stats.paymentRequests += 1;
        const startedAt = Date.now();
        const response = await requestJson("POST", `${paymentBaseUrl}/charge`, { orderId, amount: 1999 });
        paymentDuration.record(Date.now() - startedAt, runAttrs({ dependency: "mock-stripe" }));
        span.addEvent("payment_attempt", runAttrs({ attempt, status_code: response.statusCode }));
        if (response.statusCode !== 429) {
          span.setAttributes({
            "payment.attempts": attempt,
            "http.status_code": response.statusCode
          });
          return { attempt, response };
        }
        state.stats.payment429s += 1;
        state.stats.retries += 1;
        payment429Counter.add(1, runAttrs({ dependency: "mock-stripe" }));
        retryCounter.add(1, runAttrs({ dependency: "mock-stripe" }));
        log("warn", "payment dependency rate limited", { orderId, attempt, statusCode: 429 });
        if (attempt >= retryMaxAttempts) {
          span.setAttributes({
            "payment.attempts": attempt,
            "http.status_code": response.statusCode,
            "retry.exhausted": true
          });
          return { attempt, response };
        }
        const delay = retryBackoffMode === "fixed" ? retryIntervalMs : retryIntervalMs * attempt;
        await sleep(delay);
      }
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      span.end();
    }
  });
}

function resetState(runId) {
  if (state.activeWorkers !== 0 || state.queue.length !== 0) {
    const error = new Error("cannot reset while worker pool is active");
    error.statusCode = 409;
    throw error;
  }
  state.orders.clear();
  state.nextOrderId = 1;
  state.currentRunId = runId || `run-${Date.now()}`;
  state.stats.checkoutRequests = 0;
  state.stats.checkoutSuccesses = 0;
  state.stats.checkoutFailures = 0;
  state.stats.orderRequests = 0;
  state.stats.orderFailures = 0;
  state.stats.payment429s = 0;
  state.stats.paymentRequests = 0;
  state.stats.route504s = 0;
  state.stats.dbConnectionCount = 0;
  state.stats.retries = 0;
  log("info", "validation web state reset", { runId: state.currentRunId });
}

async function main() {
  state.logStream = initLogStream(appLogFile);
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${otlpEndpoint}/v1/metrics` }),
      exportIntervalMillis: 2000
    })
  });
  await sdk.start();

  tracer = trace.getTracer("validation-web");
  meter = metrics.getMeter("validation-web");
  checkoutRequestCounter = meter.createCounter("checkout_requests_total");
  checkoutFailureCounter = meter.createCounter("checkout_failures_total");
  orderRequestCounter = meter.createCounter("order_requests_total");
  orderFailureCounter = meter.createCounter("order_failures_total");
  payment429Counter = meter.createCounter("payment_429_total");
  retryCounter = meter.createCounter("retry_attempts_total");
  route504Counter = meter.createCounter("route_504_total");
  checkoutDuration = meter.createHistogram("checkout_duration_ms");
  paymentDuration = meter.createHistogram("payment_duration_ms");
  orderDuration = meter.createHistogram("order_duration_ms");
  meter.createObservableGauge("worker_pool_in_use", {
    description: "Current number of active checkout workers"
  }).addCallback((result) => result.observe(state.activeWorkers, runAttrs()));
  meter.createObservableGauge("queue_depth", {
    description: "Current size of the checkout queue"
  }).addCallback((result) => result.observe(state.queue.length, runAttrs()));
  meter.createObservableGauge("db_connection_count", {
    description: "Observed database socket connections"
  }).addCallback((result) => result.observe(state.stats.dbConnectionCount, runAttrs()));

  const ctx = {
    state,
    config: {
      checkoutConcurrency,
      checkoutTimeoutMs,
      orderTimeoutMs,
      orderQueueFailThreshold,
      retryMaxAttempts,
      retryIntervalMs,
      retryBackoffMode
    },
    tracer,
    counters: {
      checkoutRequestCounter,
      checkoutFailureCounter,
      orderRequestCounter,
      orderFailureCounter,
      payment429Counter,
      retryCounter,
      route504Counter
    },
    histograms: {
      checkoutDuration,
      paymentDuration,
      orderDuration
    },
    enqueueWork,
    callPayment,
    sendJson,
    sleep,
    log,
    runAttrs
  };

  const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/health") {
    handleHealth(req, res, ctx);
    return;
  }
  if (req.method === "GET" && url.pathname === "/metrics") {
    handleMetrics(req, res, ctx);
    return;
  }
  if (req.method === "POST" && url.pathname === "/__admin/reset") {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body = {};
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      } catch (error) {
        sendJson(res, 400, { error: "invalid json body" });
        return;
      }
      try {
        resetState(body.runId);
        sendJson(res, 200, { ok: true, runId: state.currentRunId });
      } catch (error) {
        sendJson(res, error.statusCode || 500, { error: error.message });
      }
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/db/recent-orders") {
    handleDbRecentOrders(req, res, ctx);
    return;
  }
  if (req.method === "POST" && url.pathname === "/notifications/send") {
    handleNotificationsSend(req, res, ctx);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/orders") {
    handleApiOrders(req, res, ctx);
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/orders/")) {
    handleOrder(res, url.pathname.split("/").pop(), ctx);
    return;
  }
  if (req.method === "POST" && url.pathname === "/checkout") {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body = {};
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      } catch (error) {
        sendJson(res, 400, { error: "invalid json body" });
        return;
      }
      handleCheckout(req, res, body, ctx);
    });
    return;
  }
  sendJson(res, 404, { error: "not found" });
  });

  server.listen(port, () => {
    log("info", "validation web started", { port, checkoutConcurrency, retryMaxAttempts });
  });

  process.on("SIGTERM", async () => {
    if (state.logStream) {
      state.logStream.end();
    }
    await sdk.shutdown();
    process.exit(0);
  });
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
