const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const port = Number(process.env.PORT || 8080);
const defaultTargetBaseUrl = process.env.TARGET_BASE_URL || "http://web:3000";
const appLogFile = process.env.APP_LOG_FILE || "";
let targetBaseUrl = defaultTargetBaseUrl;
let logStream = null;

const defaultProfiles = {
  stop: { rps: 0, routes: [] },
  baseline: {
    rps: 8,
    routes: [
      { method: "POST", path: "/checkout", weight: 7, body: { sku: "flash-sale-item" } },
      { method: "GET", path: "/orders/ord_000001", weight: 2 },
      { method: "GET", path: "/health", weight: 1 }
    ]
  },
  flash_sale: {
    rps: 80,
    routes: [
      { method: "POST", path: "/checkout", weight: 5, body: { sku: "flash-sale-item" } },
      { method: "GET", path: "/orders/ord_000001", weight: 4 },
      { method: "GET", path: "/health", weight: 1 }
    ]
  }
};

let profiles = JSON.parse(JSON.stringify(defaultProfiles));

const state = {
  profile: process.env.LOADGEN_PROFILE || "baseline",
  currentRps: 0,
  startedAt: new Date().toISOString(),
  sent: 0,
  succeeded: 0,
  failed: 0
};

function log(message, fields = {}) {
  const payload = { ts: new Date().toISOString(), message, ...fields };
  process.stdout.write(JSON.stringify(payload) + "\n");
  if (logStream) {
    logStream.write(JSON.stringify(payload) + "\n");
  }
}

if (appLogFile) {
  fs.mkdirSync(path.dirname(appLogFile), { recursive: true });
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

function request(route) {
  const baseUrl = route.target_url || targetBaseUrl;
  const url = new URL(route.path, baseUrl);
  const payload = route.body ? JSON.stringify(route.body) : "";
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: route.method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          ...(route.headers || {})
        }
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode || 500));
      }
    );
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function pickRoute(profile) {
  const routes = profile.routes || [];
  if (routes.length === 0) {
    return { method: "GET", path: "/health" };
  }
  const totalWeight = routes.reduce((sum, route) => sum + (route.weight || 1), 0);
  let needle = Math.random() * totalWeight;
  for (const route of routes) {
    needle -= route.weight || 1;
    if (needle <= 0) {
      return route;
    }
  }
  return routes[routes.length - 1];
}

async function fireOne(profile) {
  state.sent += 1;
  const route = pickRoute(profile);
  try {
    const statusCode = await request(route);
    if (statusCode >= 200 && statusCode < 400) {
      state.succeeded += 1;
    } else {
      state.failed += 1;
    }
  } catch (error) {
    state.failed += 1;
  }
}

setInterval(() => {
  const profile = profiles[state.profile] || profiles.baseline;
  state.currentRps = profile.rps;
  for (let i = 0; i < profile.rps; i += 1) {
    setTimeout(() => {
      fireOne(profile);
    }, Math.floor((1000 / Math.max(profile.rps, 1)) * i));
  }
}, 1000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/__admin/state") {
    sendJson(res, 200, state);
    return;
  }
  if (req.method === "POST" && url.pathname === "/__admin/target") {
    try {
      const body = await readJson(req);
      if (!body.url) {
        sendJson(res, 400, { error: "url required" });
        return;
      }
      targetBaseUrl = body.url;
      log("loadgen target changed", { targetBaseUrl });
      sendJson(res, 200, { targetBaseUrl });
    } catch (error) {
      sendJson(res, 400, { error: "invalid json body" });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/__admin/profile") {
    try {
      const body = await readJson(req);
      if (!body.profile) {
        sendJson(res, 400, { error: "profile required" });
        return;
      }
      if (body.config) {
        profiles[body.profile] = {
          rps: Number(body.config.rps || 0),
          routes: Array.isArray(body.config.routes) ? body.config.routes : []
        };
      }
      if (!profiles[body.profile]) {
        sendJson(res, 400, { error: "invalid profile" });
        return;
      }
      state.profile = body.profile;
      state.startedAt = new Date().toISOString();
      log("load profile changed", { profile: state.profile, rps: profiles[body.profile].rps });
      sendJson(res, 200, state);
    } catch (error) {
      sendJson(res, 400, { error: "invalid json body" });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/__admin/reset") {
    profiles = JSON.parse(JSON.stringify(defaultProfiles));
    targetBaseUrl = defaultTargetBaseUrl;
    state.profile = "stop";
    state.currentRps = 0;
    state.startedAt = new Date().toISOString();
    state.sent = 0;
    state.succeeded = 0;
    state.failed = 0;
    log("loadgen reset", {});
    sendJson(res, 200, state);
    return;
  }
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { status: "ok", profile: state.profile });
    return;
  }
  sendJson(res, 404, { error: "not found" });
});

server.listen(port, () => {
  log("loadgen started", { port });
});

process.on("SIGTERM", () => {
  if (logStream) {
    logStream.end();
  }
  process.exit(0);
});
