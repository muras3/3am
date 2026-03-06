const fs = require("fs");
const path = require("path");
const http = require("http");
const { URL } = require("url");
const yaml = require("js-yaml");

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
  return yaml.load(raw);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function resetFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "");
}

function resetCollectorArtifacts(baseDir) {
  resetFile(path.join(baseDir, "traces.json"));
  resetFile(path.join(baseDir, "logs.jsonl"));
  resetFile(path.join(baseDir, "metrics.json"));
}

function mergeLogFiles(logFiles) {
  const entries = [];
  for (const filePath of logFiles) {
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        entries.push({ ts: parsed.ts || "", line: JSON.stringify(parsed) });
      } catch (error) {
        entries.push({ ts: "", line });
      }
    }
  }
  entries.sort((a, b) => a.ts.localeCompare(b.ts));
  return entries.map((entry) => entry.line).join("\n") + (entries.length ? "\n" : "");
}

function mergePlatformLogs(logFiles, events) {
  const entries = [];
  for (const line of mergeLogFiles(logFiles).split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      entries.push({ ts: parsed.ts || "", record: parsed });
    } catch (error) {
      entries.push({ ts: "", record: { raw: line } });
    }
  }
  for (const event of events) {
    entries.push({ ts: event.ts || "", record: { ...event, source: "scenario-runner" } });
  }
  entries.sort((a, b) => a.ts.localeCompare(b.ts));
  return JSON.stringify(entries.map((entry) => entry.record), null, 2) + "\n";
}

function buildProbeScenario(scenarioId, scenario, groundTruth) {
  const probeGroundTruth = {
    primary_root_cause: groundTruth.primary_root_cause,
    contributing_root_causes: groundTruth.contributing_root_causes || [],
    detail: groundTruth.detail,
    recommended_actions: groundTruth.recommended_actions,
    t_first_symptom_oracle: groundTruth.t_first_symptom_oracle
  };
  return {
    schema_version: "0.1",
    id: scenarioId,
    description: scenario.description,
    source_references: [],
    ground_truth: probeGroundTruth,
    inputs: [
      { type: "otel_traces", paths: ["otel_traces.json"] },
      { type: "otel_logs", paths: ["otel_logs.json"] },
      { type: "otel_metrics", paths: ["otel_metrics.json"] },
      { type: "platform_logs", paths: ["platform_logs.json"] }
    ],
    tags: ["validation", "docker-compose", "rate-limiting", "retry-storm", "504", "worker-pool"]
  };
}

function buildSummary(metricsBody, loadgenBody, stripeBody, events) {
  const stats = metricsBody.stats || {};
  const config = metricsBody.config || {};
  const successRate = loadgenBody.sent ? loadgenBody.succeeded / loadgenBody.sent : 0;
  const failureRate = loadgenBody.sent ? loadgenBody.failed / loadgenBody.sent : 0;
  return {
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
    observed_pattern: {
      trigger_phase: "flash_sale",
      dependency_failure_mode: stripeBody.mode,
      shared_resource: "checkout worker pool",
      blast_radius: stats.route504s > 0 ? "checkout requests timing out" : "no timeout observed"
    },
    derived_signals: {
      worker_pool_saturated: metricsBody.activeWorkers === config.checkoutConcurrency,
      queue_backlog_present: (metricsBody.queueDepth || 0) > 0,
      retry_storm_present: (stats.retries || 0) > Math.max(10, (stats.checkoutRequests || 0) * 0.25),
      payment_429_ratio: stats.paymentRequests ? stats.payment429s / stats.paymentRequests : 0,
      request_failure_rate: failureRate,
      request_success_rate: successRate
    },
    raw: {
      web_metrics: metricsBody,
      loadgen: loadgenBody,
      dependency_state: stripeBody
    }
  };
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
  const webLogPath = path.join(path.dirname(outputDir), "service-logs", "web.jsonl");
  const stripeLogPath = path.join(path.dirname(outputDir), "service-logs", "mock-stripe.jsonl");
  const loadgenLogPath = path.join(path.dirname(outputDir), "service-logs", "loadgen.jsonl");

  ensureDir(runDir);
  ensureDir(collectorDir);
  resetCollectorArtifacts(collectorDir);
  resetFile(webLogPath);
  resetFile(stripeLogPath);
  resetFile(loadgenLogPath);

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
        ...buildSummary(metrics.body, loadgenState.body, stripeState.body, events)
      },
      null,
      2
    ) + "\n"
  );

  const mergedServiceLogs = mergeLogFiles([webLogPath, stripeLogPath, loadgenLogPath]);
  copyIfExists(path.join(collectorDir, "traces.json"), path.join(runDir, "traces.json"), "[]\n");
  copyIfExists(path.join(collectorDir, "traces.json"), path.join(runDir, "otel_traces.json"), "[]\n");
  copyIfExists(path.join(collectorDir, "logs.jsonl"), path.join(runDir, "otel_logs.json"), "[]\n");
  copyIfExists(path.join(collectorDir, "metrics.json"), path.join(runDir, "metrics.json"), "{}\n");
  copyIfExists(path.join(collectorDir, "metrics.json"), path.join(runDir, "otel_metrics.json"), "{}\n");
  fs.writeFileSync(path.join(runDir, "logs.jsonl"), mergedServiceLogs);
  fs.writeFileSync(
    path.join(runDir, "platform_logs.json"),
    mergePlatformLogs([webLogPath, stripeLogPath, loadgenLogPath], events)
  );

  const groundTruth = JSON.parse(fs.readFileSync(groundTruthPath, "utf8"));
  fs.writeFileSync(path.join(runDir, "ground_truth.json"), JSON.stringify(groundTruth, null, 2) + "\n");
  fs.writeFileSync(
    path.join(runDir, "scenario.probe.json"),
    JSON.stringify(buildProbeScenario(scenarioId, scenario, groundTruth), null, 2) + "\n"
  );

  process.stdout.write(`scenario completed: ${runDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
