const http = require("http");
const fs = require("fs");
const { URL } = require("url");

const port = Number(process.env.PORT || 4000);
const appLogFile = process.env.APP_LOG_FILE || "";
let logStream = null;
const state = {
  mode: process.env.DEFAULT_MODE || "normal",
  latencyMs: Number(process.env.DEFAULT_LATENCY_MS || 120),
  rateLimitStatus: Number(process.env.RATE_LIMIT_STATUS || 429),
  rateLimitLatencyMs: Number(process.env.RATE_LIMIT_LATENCY_MS || 250)
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

function sendJson(res, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/__admin/state") {
    sendJson(res, 200, state);
    return;
  }
  if (req.method === "POST" && url.pathname === "/__admin/mode") {
    try {
      const body = await readJson(req);
      state.mode = body.mode || state.mode;
      if (body.config && typeof body.config.response_latency_ms === "number") {
        state.rateLimitLatencyMs = body.config.response_latency_ms;
      }
      if (body.config && typeof body.config.status_code === "number") {
        state.rateLimitStatus = body.config.status_code;
      }
      log("mock-stripe mode updated", { mode: state.mode, rateLimitStatus: state.rateLimitStatus });
      sendJson(res, 200, state);
    } catch (error) {
      sendJson(res, 400, { error: "invalid json body" });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/__admin/reset") {
    state.mode = process.env.DEFAULT_MODE || "normal";
    state.latencyMs = Number(process.env.DEFAULT_LATENCY_MS || 120);
    state.rateLimitStatus = Number(process.env.RATE_LIMIT_STATUS || 429);
    state.rateLimitLatencyMs = Number(process.env.RATE_LIMIT_LATENCY_MS || 250);
    log("mock-stripe reset", { mode: state.mode });
    sendJson(res, 200, state);
    return;
  }
  if (req.method === "POST" && url.pathname === "/charge") {
    if (state.mode === "rate_limited") {
      await sleep(state.rateLimitLatencyMs);
      log("mock-stripe returning rate limit", { statusCode: state.rateLimitStatus });
      sendJson(
        res,
        state.rateLimitStatus,
        { error: "rate limited", provider: "mock-stripe" },
        {
          "x-ratelimit-limit": "100",
          "x-ratelimit-remaining": "0",
          "retry-after": "1"
        }
      );
      return;
    }
    await sleep(state.latencyMs);
    sendJson(res, 200, { ok: true, provider: "mock-stripe" });
    return;
  }
  sendJson(res, 404, { error: "not found" });
});

server.listen(port, () => {
  log("mock-stripe started", { port });
});

process.on("SIGTERM", () => {
  if (logStream) {
    logStream.end();
  }
  process.exit(0);
});
