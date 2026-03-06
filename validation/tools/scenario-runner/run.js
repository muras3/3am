const fs = require("fs");
const path = require("path");
const http = require("http");
const { URL } = require("url");

const scenarioPath = process.env.SCENARIO_FILE;
const groundTruthPath = process.env.GROUND_TRUTH_FILE;
const outputDir = process.env.OUTPUT_DIR || "/workspace/out/runs";
const collectorDir = process.env.OTEL_COLLECTOR_DIR || "/workspace/out/collector";
const webBaseUrl = process.env.WEB_BASE_URL || "http://web:3000";
const stripeAdminUrl = process.env.STRIPE_ADMIN_URL || "http://mock-stripe:4000/__admin";
const loadgenControlUrl = process.env.LOADGEN_CONTROL_URL || "http://loadgen:8080";

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
          resolve({ statusCode: res.statusCode || 500, body: parsed });
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(urlString, label) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await requestJson("GET", urlString);
      if (response.statusCode === 200) {
        return;
      }
    } catch (error) {}
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function parseScenarioYaml(raw) {
  const data = {
    runtime: {},
    fault_injection: { config: {} },
    ground_truth: {}
  };
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("warmup_sec:")) data.runtime.warmup_sec = Number(trimmed.split(":")[1].trim());
    if (trimmed.startsWith("steady_state_sec:")) data.runtime.steady_state_sec = Number(trimmed.split(":")[1].trim());
    if (trimmed.startsWith("incident_sec:")) data.runtime.incident_sec = Number(trimmed.split(":")[1].trim());
    if (trimmed.startsWith("cooldown_sec:")) data.runtime.cooldown_sec = Number(trimmed.split(":")[1].trim());
    if (trimmed.startsWith("at_sec:")) data.fault_injection.at_sec = Number(trimmed.split(":")[1].trim());
    if (trimmed.startsWith("mode:")) data.fault_injection.mode = trimmed.split(":")[1].trim();
    if (trimmed.startsWith("status_code:")) data.fault_injection.config.status_code = Number(trimmed.split(":")[1].trim());
    if (trimmed.startsWith("response_latency_ms:")) data.fault_injection.config.response_latency_ms = Number(trimmed.split(":")[1].trim());
    if (trimmed.startsWith("trigger:")) data.ground_truth.trigger = trimmed.split(":").slice(1).join(":").trim();
    if (trimmed.startsWith("root_cause:")) data.ground_truth.root_cause = trimmed.split(":").slice(1).join(":").trim();
  }
  return data;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyIfExists(src, dest, fallback) {
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    return;
  }
  fs.writeFileSync(dest, fallback);
}

async function main() {
  const scenarioId = process.argv[2] || "third_party_api_rate_limit_cascade";
  const scenario = parseScenarioYaml(fs.readFileSync(scenarioPath, "utf8"));
  const startedAt = new Date();
  const runDir = path.join(outputDir, `${startedAt.toISOString().replace(/[:.]/g, "-")}-${scenarioId}`);
  const events = [];

  ensureDir(runDir);
  ensureDir(collectorDir);

  await waitForHealth(`${webBaseUrl}/health`, "web");
  await waitForHealth(`${loadgenControlUrl}/health`, "loadgen");
  await waitForHealth(`${stripeAdminUrl}/state`, "mock-stripe");

  events.push({ ts: new Date().toISOString(), type: "scenario_started", scenario_id: scenarioId });

  await requestJson("POST", `${loadgenControlUrl}/__admin/profile`, { profile: "baseline" });
  events.push({ ts: new Date().toISOString(), type: "load_profile_changed", profile: "baseline" });
  await sleep(Math.min((scenario.runtime.warmup_sec || 10) * 1000, 5000));

  await requestJson("POST", `${loadgenControlUrl}/__admin/profile`, { profile: "flash_sale" });
  events.push({ ts: new Date().toISOString(), type: "load_profile_changed", profile: "flash_sale" });
  await sleep(Math.min((scenario.runtime.steady_state_sec || 10) * 1000, 5000));

  await requestJson("POST", `${stripeAdminUrl}/mode`, {
    mode: scenario.fault_injection.mode || "rate_limited",
    config: scenario.fault_injection.config
  });
  events.push({
    ts: new Date().toISOString(),
    type: "dependency_mode_changed",
    service: "mock-stripe",
    mode: scenario.fault_injection.mode || "rate_limited"
  });

  await sleep(Math.min((scenario.runtime.incident_sec || 10) * 1000, 7000));

  await requestJson("POST", `${loadgenControlUrl}/__admin/profile`, { profile: "stop" });
  events.push({ ts: new Date().toISOString(), type: "load_profile_changed", profile: "stop" });
  await sleep(Math.min((scenario.runtime.cooldown_sec || 5) * 1000, 3000));

  events.push({ ts: new Date().toISOString(), type: "scenario_completed", scenario_id: scenarioId });

  const metrics = await requestJson("GET", `${webBaseUrl}/metrics`);
  const loadgenState = await requestJson("GET", `${loadgenControlUrl}/__admin/state`);
  const stripeState = await requestJson("GET", `${stripeAdminUrl}/state`);

  fs.writeFileSync(path.join(runDir, "events.json"), JSON.stringify(events, null, 2) + "\n");
  fs.writeFileSync(
    path.join(runDir, "summary.json"),
    JSON.stringify(
      {
        scenario_id: scenarioId,
        incident_window: {
          started_at: events[0].ts,
          ended_at: events[events.length - 1].ts
        },
        top_errors: [
          "payment dependency rate limited",
          "checkout failed after retries"
        ],
        impacted_routes: ["/checkout"],
        suspicious_dependencies: ["mock-stripe"],
        web_metrics: metrics.body,
        loadgen: loadgenState.body,
        dependency_state: stripeState.body
      },
      null,
      2
    ) + "\n"
  );

  copyIfExists(
    path.join(collectorDir, "traces.json"),
    path.join(runDir, "traces.json"),
    "[]\n"
  );
  copyIfExists(
    path.join(collectorDir, "logs.jsonl"),
    path.join(runDir, "logs.jsonl"),
    ""
  );
  copyIfExists(
    path.join(collectorDir, "metrics.json"),
    path.join(runDir, "metrics.json"),
    "{}\n"
  );

  const groundTruth = JSON.parse(fs.readFileSync(groundTruthPath, "utf8"));
  fs.writeFileSync(path.join(runDir, "ground_truth.json"), JSON.stringify(groundTruth, null, 2) + "\n");

  process.stdout.write(`scenario completed: ${runDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
