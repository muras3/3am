const http = require("http");
const { URL } = require("url");

const port = Number(process.env.PORT || 8080);
const targetBaseUrl = process.env.TARGET_BASE_URL || "http://web:3000";
const state = {
  profile: process.env.LOADGEN_PROFILE || "baseline",
  currentRps: 0,
  startedAt: new Date().toISOString(),
  sent: 0,
  succeeded: 0,
  failed: 0
};

const profiles = {
  stop: { rps: 0 },
  baseline: { rps: 8 },
  flash_sale: { rps: 80 }
};

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

function request(method, path, body) {
  const url = new URL(path, targetBaseUrl);
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

async function fireOne() {
  state.sent += 1;
  const pick = state.sent % 10;
  const route = pick < 8 ? { method: "POST", path: "/checkout", body: { sku: "flash-sale-item" } }
    : pick === 8 ? { method: "GET", path: "/orders/ord_000001" }
    : { method: "GET", path: "/health" };
  try {
    const statusCode = await request(route.method, route.path, route.body);
    if (statusCode >= 200 && statusCode < 500) {
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
    setTimeout(fireOne, Math.floor((1000 / Math.max(profile.rps, 1)) * i));
  }
}, 1000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/__admin/state") {
    sendJson(res, 200, state);
    return;
  }
  if (req.method === "POST" && url.pathname === "/__admin/profile") {
    try {
      const body = await readJson(req);
      if (!profiles[body.profile]) {
        sendJson(res, 400, { error: "invalid profile" });
        return;
      }
      state.profile = body.profile;
      state.startedAt = new Date().toISOString();
      sendJson(res, 200, state);
    } catch (error) {
      sendJson(res, 400, { error: "invalid json body" });
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { status: "ok", profile: state.profile });
    return;
  }
  sendJson(res, 404, { error: "not found" });
});

server.listen(port, () => {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), msg: "loadgen started", port }) + "\n");
});

