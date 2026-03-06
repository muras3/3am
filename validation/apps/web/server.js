const http = require("http");
const net = require("net");
const fs = require("fs");
const { URL } = require("url");
const { trace, metrics, SpanStatusCode } = require("@opentelemetry/api");
const { NodeSDK } = require("@opentelemetry/sdk-node");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { OTLPMetricExporter } = require("@opentelemetry/exporter-metrics-otlp-http");
const { PeriodicExportingMetricReader } = require("@opentelemetry/sdk-metrics");

const port = Number(process.env.PORT || 3000);
const paymentBaseUrl = process.env.PAYMENT_BASE_URL || "http://mock-stripe:4000";
const dbHost = process.env.DATABASE_HOST || "postgres";
const dbPort = Number(process.env.DATABASE_PORT || 5432);
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://otel-collector:4318";
const appLogFile = process.env.APP_LOG_FILE || "";
const checkoutConcurrency = Number(process.env.CHECKOUT_CONCURRENCY || 16);
const checkoutTimeoutMs = Number(process.env.CHECKOUT_TIMEOUT_MS || 30000);
const retryMaxAttempts = Number(process.env.RETRY_MAX_ATTEMPTS || 5);
const retryIntervalMs = Number(process.env.RETRY_INTERVAL_MS || 100);
const retryBackoffMode = process.env.RETRY_BACKOFF_MODE || "fixed";

const orders = new Map();
let activeWorkers = 0;
const queue = [];
let nextOrderId = 1;
let logStream = null;
const stats = {
  checkoutRequests: 0,
  checkoutSuccesses: 0,
  checkoutFailures: 0,
  payment429s: 0,
  paymentRequests: 0,
  route504s: 0,
  dbConnectionCount: 0,
  retries: 0
};
let tracer;
let meter;
let checkoutRequestCounter;
let checkoutFailureCounter;
let payment429Counter;
let retryCounter;
let route504Counter;
let checkoutDuration;
let paymentDuration;

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
    ...fields
  };
  process.stdout.write(JSON.stringify(payload) + "\n");
  if (logStream) {
    logStream.write(JSON.stringify(payload) + "\n");
  }
}

function observeDbConnection() {
  const socket = net.createConnection({ host: dbHost, port: dbPort });
  socket.on("connect", () => {
    stats.dbConnectionCount += 1;
    setTimeout(() => socket.end(), 50);
  });
  socket.on("error", () => {});
}

setInterval(observeDbConnection, 2000);

function enqueueCheckout(task) {
  return new Promise((resolve, reject) => {
    const enqueuedAt = Date.now();
    const wrapped = async () => {
      const queueWaitMs = Date.now() - enqueuedAt;
      const timer = setTimeout(() => {
        reject(Object.assign(new Error("checkout timed out"), { statusCode: 504 }));
      }, checkoutTimeoutMs);
      try {
        const result = await task(queueWaitMs);
        clearTimeout(timer);
        resolve(result);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      } finally {
        activeWorkers -= 1;
        drainQueue();
      }
    };
    queue.push(wrapped);
    drainQueue();
  });
}

function drainQueue() {
  while (activeWorkers < checkoutConcurrency && queue.length > 0) {
    const task = queue.shift();
    activeWorkers += 1;
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
        stats.paymentRequests += 1;
        const startedAt = Date.now();
        const response = await requestJson("POST", `${paymentBaseUrl}/charge`, { orderId, amount: 1999 });
        paymentDuration.record(Date.now() - startedAt, { dependency: "mock-stripe" });
        span.addEvent("payment_attempt", { attempt, status_code: response.statusCode });
        if (response.statusCode !== 429) {
          span.setAttributes({
            "payment.attempts": attempt,
            "http.status_code": response.statusCode
          });
          return { attempt, response };
        }
        stats.payment429s += 1;
        stats.retries += 1;
        payment429Counter.add(1, { dependency: "mock-stripe" });
        retryCounter.add(1, { dependency: "mock-stripe" });
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

async function handleCheckout(req, res, body) {
  stats.checkoutRequests += 1;
  checkoutRequestCounter.add(1, { route: "/checkout" });
  const orderId = `ord_${String(nextOrderId++).padStart(6, "0")}`;
  const startedAt = Date.now();
  return tracer.startActiveSpan("checkout.request", async (span) => {
    span.setAttributes({
      "app.route": "/checkout",
      "app.order_id": orderId
    });
    try {
      const result = await enqueueCheckout(async (queueWaitMs) => {
        span.setAttribute("queue.wait_ms", queueWaitMs);
        const payment = await callPayment(orderId);
        const order = {
          id: orderId,
          sku: body.sku || "demo-sku",
          status: payment.response.statusCode === 200 ? "paid" : "pending",
          queueWaitMs,
          paymentAttempts: payment.attempt
        };
        orders.set(orderId, order);
        if (payment.response.statusCode === 200) {
          stats.checkoutSuccesses += 1;
          log("info", "checkout completed", { orderId, queueWaitMs, paymentAttempts: payment.attempt });
          span.setAttributes({
            "payment.attempts": payment.attempt,
            "http.status_code": 200
          });
          return { statusCode: 200, payload: order };
        }
        stats.checkoutFailures += 1;
        stats.route504s += 1;
        checkoutFailureCounter.add(1, { route: "/checkout" });
        route504Counter.add(1, { route: "/checkout" });
        log("error", "checkout failed after retries", { orderId, queueWaitMs, paymentAttempts: payment.attempt });
        span.setAttributes({
          "payment.attempts": payment.attempt,
          "http.status_code": 504
        });
        span.setStatus({ code: SpanStatusCode.ERROR, message: "payment retries exhausted" });
        return {
          statusCode: 504,
          payload: {
            error: "upstream payment retries exhausted shared worker pool",
            orderId,
            queueWaitMs,
            paymentAttempts: payment.attempt
          }
        };
      });
      checkoutDuration.record(Date.now() - startedAt, { route: "/checkout" });
      sendJson(res, result.statusCode, {
        ...result.payload,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      stats.checkoutFailures += 1;
      stats.route504s += 1;
      checkoutFailureCounter.add(1, { route: "/checkout" });
      route504Counter.add(1, { route: "/checkout" });
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      sendJson(res, error.statusCode || 500, {
        error: error.message,
        orderId,
        durationMs: Date.now() - startedAt
      });
    } finally {
      span.end();
    }
  });
}

function handleOrder(res, orderId) {
  const order = orders.get(orderId);
  if (!order) {
    sendJson(res, 404, { error: "order not found", orderId });
    return;
  }
  sendJson(res, 200, order);
}

function handleMetrics(res) {
  sendJson(res, 200, {
    service: "validation-web",
    activeWorkers,
    queueDepth: queue.length,
    stats,
    config: {
      checkoutConcurrency,
      checkoutTimeoutMs,
      retryMaxAttempts,
      retryIntervalMs,
      retryBackoffMode
    }
  });
}

async function main() {
  logStream = initLogStream(appLogFile);
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
  payment429Counter = meter.createCounter("payment_429_total");
  retryCounter = meter.createCounter("retry_attempts_total");
  route504Counter = meter.createCounter("route_504_total");
  checkoutDuration = meter.createHistogram("checkout_duration_ms");
  paymentDuration = meter.createHistogram("payment_duration_ms");
  meter.createObservableGauge("worker_pool_in_use", {
    description: "Current number of active checkout workers"
  }).addCallback((result) => result.observe(activeWorkers));
  meter.createObservableGauge("queue_depth", {
    description: "Current size of the checkout queue"
  }).addCallback((result) => result.observe(queue.length));
  meter.createObservableGauge("db_connection_count", {
    description: "Observed database socket connections"
  }).addCallback((result) => result.observe(stats.dbConnectionCount));

  const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { status: "ok", activeWorkers, queueDepth: queue.length });
    return;
  }
  if (req.method === "GET" && url.pathname === "/metrics") {
    handleMetrics(res);
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/orders/")) {
    handleOrder(res, url.pathname.split("/").pop());
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
      handleCheckout(req, res, body);
    });
    return;
  }
  sendJson(res, 404, { error: "not found" });
  });

  server.listen(port, () => {
    log("info", "validation web started", { port, checkoutConcurrency, retryMaxAttempts });
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
