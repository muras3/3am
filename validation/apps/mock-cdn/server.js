const http = require("http");
const fs = require("fs");
const { URL } = require("url");
const { trace, metrics, SpanStatusCode } = require("@opentelemetry/api");
const { logs } = require("@opentelemetry/api-logs");
const { NodeSDK } = require("@opentelemetry/sdk-node");
const { BatchLogRecordProcessor } = require("@opentelemetry/sdk-logs");
const { OTLPLogExporter } = require("@opentelemetry/exporter-logs-otlp-http");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { OTLPMetricExporter } = require("@opentelemetry/exporter-metrics-otlp-http");
const { PeriodicExportingMetricReader } = require("@opentelemetry/sdk-metrics");

const port = Number(process.env.PORT || 3001);
const webOriginUrl = process.env.WEB_ORIGIN_URL || "http://web:3000";
const cdnCacheTtlSec = process.env.CDN_CACHE_TTL_SEC ? Number(process.env.CDN_CACHE_TTL_SEC) : null;
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://otel-collector:4318";
const appLogFile = process.env.APP_LOG_FILE || "";

const cache = new Map();
const stats = { hitCount: 0, missCount: 0, cachedErrorsTotal: 0 };

let tracer;
let otelLogger;
let cachedErrorsCounter;
let logStream = null;

if (appLogFile) {
  fs.mkdirSync(require("path").dirname(appLogFile), { recursive: true });
  logStream = fs.createWriteStream(appLogFile, { flags: "a" });
}

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

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders
  });
  res.end(body);
}

function cacheKey(method, host, pathname, search) {
  return `${method}:${host}:${pathname}:${search}`;
}

function parseSMaxAge(cacheControl) {
  if (!cacheControl) return null;
  const match = cacheControl.match(/s-maxage=(\d+)/);
  return match ? Number(match[1]) : null;
}

function isPublic(cacheControl) {
  return cacheControl && cacheControl.includes("public");
}

function proxyRequest(method, pathname, search, reqHeaders) {
  const origin = new URL(webOriginUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        hostname: origin.hostname,
        port: origin.port,
        path: pathname + search,
        headers: {
          ...reqHeaders,
          host: `${origin.hostname}:${origin.port}`
        }
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode || 500,
            headers: res.headers,
            body: Buffer.concat(chunks)
          });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function handleAdmin(req, res, url) {
  if (req.method === "GET" && url.pathname === "/__admin/health") {
    sendJson(res, 200, { status: "ok" });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/__admin/state") {
    sendJson(res, 200, {
      hitCount: stats.hitCount,
      missCount: stats.missCount,
      cachedEntries: cache.size,
      cachedErrorsTotal: stats.cachedErrorsTotal
    });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/__admin/purge") {
    cache.clear();
    log("cache purged");
    sendJson(res, 200, { purged: true });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/__admin/reset") {
    cache.clear();
    stats.hitCount = 0;
    stats.missCount = 0;
    stats.cachedErrorsTotal = 0;
    log("cdn reset");
    sendJson(res, 200, { reset: true });
    return true;
  }
  return false;
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith("/__admin")) {
    if (handleAdmin(req, res, url)) return;
    sendJson(res, 404, { error: "not found" });
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = await proxyRequest(req.method, url.pathname, url.search, req.headers);
    res.writeHead(origin.statusCode, origin.headers);
    res.end(origin.body);
    return;
  }

  const key = cacheKey(req.method, url.host, url.pathname, url.search);

  return tracer.startActiveSpan("cdn.request", async (span) => {
    try {
      const entry = cache.get(key);
      if (entry && Date.now() < entry.expiresAt) {
        stats.hitCount += 1;
        const ageSec = Math.floor((Date.now() - entry.cachedAt) / 1000);
        span.setAttributes({
          "cdn.cache_status": "HIT",
          "cdn.cached_status_code": entry.statusCode,
          "http.response.status_code": entry.statusCode,
          "cdn.age_sec": ageSec,
          "http.response.header.cache_control": entry.cacheControl || ""
        });
        if (entry.statusCode >= 500) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          log("serving stale error from cache", { key, statusCode: entry.statusCode, ageSec, cacheControl: entry.cacheControl }, "warn");
        } else {
          log("cache hit", { key, statusCode: entry.statusCode, ageSec });
        }
        const headers = { ...entry.headers, "x-cache": "HIT", age: String(ageSec) };
        res.writeHead(entry.statusCode, headers);
        res.end(entry.body);
        return;
      }

      stats.missCount += 1;
      const origin = await proxyRequest(req.method, url.pathname, url.search, req.headers);
      const cc = origin.headers["cache-control"] || "";
      const sMaxAge = parseSMaxAge(cc);

      span.setAttributes({
        "cdn.cache_status": "MISS",
        "cdn.cached_status_code": origin.statusCode,
        "http.response.status_code": origin.statusCode,
        "cdn.age_sec": 0,
        "http.response.header.cache_control": cc
      });
      if (origin.statusCode >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }

      if (isPublic(cc) && sMaxAge !== null) {
        const ttl = cdnCacheTtlSec !== null ? cdnCacheTtlSec : sMaxAge;
        const now = Date.now();
        cache.set(key, {
          statusCode: origin.statusCode,
          body: origin.body,
          headers: { ...origin.headers },
          cacheControl: cc,
          cachedAt: now,
          expiresAt: now + ttl * 1000
        });
        if (origin.statusCode >= 500) {
          log("caching error response from origin", { key, statusCode: origin.statusCode, ttlSec: ttl, cacheControl: cc }, "warn");
        } else {
          log("cached response", { key, statusCode: origin.statusCode, ttlSec: ttl });
        }
        if (origin.statusCode >= 400) {
          stats.cachedErrorsTotal += 1;
          cachedErrorsCounter.add(1, { "http.status_code": origin.statusCode });
        }
      }

      const responseHeaders = { ...origin.headers, "x-cache": "MISS" };
      res.writeHead(origin.statusCode, responseHeaders);
      res.end(origin.body);
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      sendJson(res, 502, { error: "origin unreachable" });
    } finally {
      span.end();
    }
  });
}

async function main() {
  const sdk = new NodeSDK({
    serviceName: "mock-cdn",
    traceExporter: new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${otlpEndpoint}/v1/metrics` }),
      exportIntervalMillis: 2000
    }),
    logRecordProcessor: new BatchLogRecordProcessor(new OTLPLogExporter({ url: `${otlpEndpoint}/v1/logs` }))
  });
  await sdk.start();

  tracer = trace.getTracer("mock-cdn");
  otelLogger = logs.getLogger("mock-cdn");
  const meter = metrics.getMeter("mock-cdn");

  cachedErrorsCounter = meter.createCounter("cdn_cached_errors_total", {
    description: "Number of non-200 responses cached by CDN"
  });
  meter.createObservableGauge("cdn_cache_hit_ratio", {
    description: "Ratio of cache hits to total requests"
  }).addCallback((result) => {
    const total = stats.hitCount + stats.missCount;
    result.observe(total > 0 ? stats.hitCount / total : 0);
  });

  const server = http.createServer(handleRequest);
  server.listen(port, () => {
    log("mock-cdn started", { port, webOriginUrl, cdnCacheTtlSec });
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
