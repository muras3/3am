const fs = require("fs");
const path = require("path");
const http = require("http");
const { URL } = require("url");
const yaml = require("js-yaml");

const _scenarioId0 = process.argv[2] || "third_party_api_rate_limit_cascade";
const _defaultScenarioDir = `/workspace/scenarios/${_scenarioId0}`;
// argv[2] wins over env var so `docker compose run scenario-runner node /app/run.js <id>` works correctly
const scenarioPath = process.argv[2] ? `${_defaultScenarioDir}/scenario.yaml` : (process.env.SCENARIO_FILE || `${_defaultScenarioDir}/scenario.yaml`);
const groundTruthPath = process.argv[2] ? `${_defaultScenarioDir}/ground_truth.template.json` : (process.env.GROUND_TRUTH_FILE || `${_defaultScenarioDir}/ground_truth.template.json`);
const outputDir = process.env.OUTPUT_DIR || "/workspace/out/runs";
const collectorDir = process.env.OTEL_COLLECTOR_DIR || "/workspace/out/collector";
const webBaseUrl = process.env.WEB_BASE_URL || "http://web:3000";
const stripeAdminUrl = process.env.STRIPE_ADMIN_URL || "http://mock-stripe:4000/__admin";
const notificationSvcAdminUrl = process.env.NOTIFICATION_SVC_ADMIN_URL || "http://mock-notification-svc:7001";
const loadgenControlUrl = process.env.LOADGEN_CONTROL_URL || "http://loadgen:8080";
const migrationRunnerUrl = process.env.MIGRATION_RUNNER_URL || "http://migration-runner:5001";
const cdnBaseUrl = process.env.CDN_BASE_URL || "http://mock-cdn:3001";
const sendgridAdminUrl = process.env.SENDGRID_ADMIN_URL || "http://mock-sendgrid:6001";
const webV2BaseUrl = process.env.WEB_V2_BASE_URL || "http://web-v2:3000";
const receiverEndpoint = process.env.RECEIVER_ENDPOINT || "";
const receiverAuthToken = process.env.RECEIVER_AUTH_TOKEN || "";

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

async function sendPlatformEventToReceiver(event) {
  if (!receiverEndpoint) {
    process.stdout.write("[platform-events] RECEIVER_ENDPOINT not set, skipping\n");
    return;
  }
  const url = `${receiverEndpoint}/v1/platform-events`;
  const payload = JSON.stringify({ events: [event] });
  const urlObj = new URL(url);
  return new Promise((resolve) => {
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    };
    if (receiverAuthToken) headers["Authorization"] = `Bearer ${receiverAuthToken}`;
    const lib = urlObj.protocol === "https:" ? require("https") : http;
    const req = lib.request(
      {
        method: "POST",
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
        path: urlObj.pathname,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          process.stdout.write(`[platform-events] POST ${url} → ${res.statusCode} ${data.slice(0, 200)}\n`);
          resolve();
        });
      }
    );
    req.on("error", (err) => {
      process.stderr.write(`[platform-events] POST failed: ${err.message}\n`);
      resolve();
    });
    req.write(payload);
    req.end();
  });
}

async function postJsonOrThrow(urlString, body, label) {
  const response = await requestJson("POST", urlString, body);
  if (response.statusCode !== 200) {
    throw new Error(`failed to ${label}: ${response.body.error || response.statusCode}`);
  }
  return response;
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

function buildProbeScenario(scenarioId, scenario, groundTruth, inputs) {
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
    inputs,
    tags: ["validation", "docker-compose", "rate-limiting", "retry-storm", "504", "worker-pool"]
  };
}

function withOracleTimestamp(groundTruth, oracleTimestamp) {
  return {
    ...groundTruth,
    t_first_symptom_oracle: oracleTimestamp
  };
}

function collectProbeInputs(runDir) {
  const definitions = [
    { type: "otel_traces", path: "otel_traces.json" },
    { type: "otel_logs", path: "otel_logs.json" },
    { type: "otel_metrics", path: "otel_metrics.json" },
    { type: "platform_logs", path: "platform_logs.json" }
  ];
  return definitions
    .filter((entry) => {
      const fullPath = path.join(runDir, entry.path);
      return fs.existsSync(fullPath) && fs.statSync(fullPath).size > 0;
    })
    .map((entry) => ({ type: entry.type, paths: [entry.path] }));
}

function buildSummary(scenario, metricsBody, loadgenBody, dependencyState, events) {
  const stats = metricsBody.stats || {};
  const config = metricsBody.config || {};
  const expected = scenario.expected_observations || {};
  const successRate = loadgenBody.sent ? loadgenBody.succeeded / loadgenBody.sent : 0;
  const failureRate = loadgenBody.sent ? loadgenBody.failed / loadgenBody.sent : 0;
  const impactedRoutes = expected.impacted_routes || [];
  let dependencyFailureMode = dependencyState.mode || dependencyState.phase || "unknown";
  if (scenario.scenario_id === "upstream_cdn_stale_cache_poison") {
    dependencyFailureMode = dependencyState.mode || (dependencyState.cachedErrorsTotal > 0 ? "cached_error" : "unknown");
  }
  if (scenario.scenario_id === "secrets_rotation_partial_propagation") {
    const revokedKeys = dependencyState.revokedKeys || dependencyState.revoked_keys || [];
    dependencyFailureMode = revokedKeys.length > 0
      ? "revoked_key"
      : dependencyFailureMode;
  }
  return {
    incident_window: {
      started_at: events[0].ts,
      ended_at: events[events.length - 1].ts
    },
    top_errors: expected.top_errors || [],
    impacted_routes: impactedRoutes,
    suspicious_dependencies: expected.suspicious_dependencies || [],
    observed_pattern: {
      trigger_phase: "flash_sale",
      dependency_failure_mode: dependencyFailureMode,
      shared_resource: scenarioIdSharedResource(scenario),
      blast_radius: impactedRoutes.length > 1
        ? `${impactedRoutes.join(" and ")} degraded during the incident window`
        : stats.route504s > 0 ? "requests timing out" : "no timeout observed"
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
      dependency_state: dependencyState
    }
  };
}

function scenarioIdSharedResource(scenario) {
  if (scenario.scenario_id === "db_migration_lock_contention") {
    return "postgres lock queue and shared worker pool";
  }
  if (scenario.scenario_id === "cascading_timeout_downstream_dependency") {
    return "shared worker pool";
  }
  if (scenario.scenario_id === "upstream_cdn_stale_cache_poison") {
    return "mock-cdn cache state and shared request path";
  }
  if (scenario.scenario_id === "secrets_rotation_partial_propagation") {
    return "deployment-specific configuration and secret propagation";
  }
  return "checkout worker pool";
}

function copyIfExists(src, dest, fallback) {
  if (fs.existsSync(src) && fs.statSync(src).size > 0) {
    fs.copyFileSync(src, dest);
    return;
  }
  fs.writeFileSync(dest, fallback);
}

function tryNormalizeCollectorJson(src) {
  if (!fs.existsSync(src) || fs.statSync(src).size === 0) {
    return [];
  }
  const rawBuffer = fs.readFileSync(src);
  const sanitizedBuffer = Buffer.from(rawBuffer.filter((byte) => byte !== 0));
  const raw = sanitizedBuffer.toString("utf8").trim();
  if (!raw) {
    return [];
  }

  const records = [];
  for (const chunk of raw.split(/\n+/)) {
    const trimmed = chunk.trim();
    if (!trimmed) {
      continue;
    }
    records.push(JSON.parse(trimmed));
  }
  return records;
}

async function normalizeCollectorJson(src, dest, emptyFallback) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const records = tryNormalizeCollectorJson(src);
      fs.writeFileSync(dest, JSON.stringify(records, null, 2) + "\n");
      return;
    } catch (error) {
      lastError = error;
      await sleep(1000);
    }
  }
  if (!fs.existsSync(src) || fs.statSync(src).size === 0) {
    fs.writeFileSync(dest, emptyFallback);
    return;
  }
  throw lastError;
}

async function main() {
  const fastMode = process.env.FAST_MODE === "1";
  const scenarioId = process.argv[2] || "third_party_api_rate_limit_cascade";
  const scenario = parseScenarioYaml(fs.readFileSync(scenarioPath, "utf8"));
  const startedAt = new Date();
  const runId = `${scenarioId}-${startedAt.toISOString().replace(/[:.]/g, "-")}`;
  const runDir = path.join(outputDir, `${startedAt.toISOString().replace(/[:.]/g, "-")}-${scenarioId}`);
  const events = [];
  const webLogPath = path.join(path.dirname(outputDir), "service-logs", "web.jsonl");
  const stripeLogPath = path.join(path.dirname(outputDir), "service-logs", "mock-stripe.jsonl");
  const loadgenLogPath = path.join(path.dirname(outputDir), "service-logs", "loadgen.jsonl");
  const migrationLogPath = path.join(path.dirname(outputDir), "service-logs", "migration-runner.jsonl");
  const notificationLogPath = path.join(path.dirname(outputDir), "service-logs", "mock-notification-svc.jsonl");
  const cdnLogPath = path.join(path.dirname(outputDir), "service-logs", "mock-cdn.jsonl");
  const sendgridLogPath = path.join(path.dirname(outputDir), "service-logs", "mock-sendgrid.jsonl");
  const webV2LogPath = path.join(path.dirname(outputDir), "service-logs", "web-v2.jsonl");
  const faultTarget = scenario.fault_injection ? scenario.fault_injection.target : "payment_dependency";
  const isMigrationScenario = faultTarget === "migration-runner";
  const isNotificationScenario = faultTarget === "mock-notification-svc";
  const isCdnScenario = scenario.scenario_id === "upstream_cdn_stale_cache_poison" || !!(scenario.loadgen && scenario.loadgen.target_url);
  const isSendgridScenario = faultTarget === "mock-sendgrid";

  ensureDir(runDir);
  ensureDir(collectorDir);
  resetCollectorArtifacts(collectorDir);
  resetFile(webLogPath);
  resetFile(stripeLogPath);
  resetFile(loadgenLogPath);
  if (isMigrationScenario) {
    resetFile(migrationLogPath);
  }
  if (isNotificationScenario) {
    resetFile(notificationLogPath);
  }
  if (isCdnScenario) {
    resetFile(cdnLogPath);
  }
  if (isSendgridScenario) {
    resetFile(sendgridLogPath);
    resetFile(webV2LogPath);
  }

  await waitForHealth(`${webBaseUrl}/health`, "web");
  await waitForHealth(`${loadgenControlUrl}/health`, "loadgen");
  await waitForHealth(`${stripeAdminUrl}/state`, "mock-stripe");
  if (isMigrationScenario) {
    await waitForHealth(`${migrationRunnerUrl}/__admin/health`, "migration-runner");
  }
  if (isNotificationScenario) {
    await waitForHealth(`${notificationSvcAdminUrl}/__admin/health`, "mock-notification-svc");
    await postJsonOrThrow(`${notificationSvcAdminUrl}/__admin/reset`, undefined, "reset mock-notification-svc");
  }
  if (isCdnScenario) {
    await waitForHealth(`${cdnBaseUrl}/__admin/health`, "mock-cdn");
    await postJsonOrThrow(`${cdnBaseUrl}/__admin/reset`, undefined, "reset mock-cdn");
  }
  if (isSendgridScenario) {
    await waitForHealth(`${sendgridAdminUrl}/__admin/health`, "mock-sendgrid");
    await waitForHealth(`${webV2BaseUrl}/health`, "web-v2");
  }

  await postJsonOrThrow(`${loadgenControlUrl}/__admin/reset`, undefined, "reset loadgen");
  await sleep(300); // let in-flight requests drain before resetting web worker pool
  await postJsonOrThrow(`${webBaseUrl}/__admin/reset`, { runId }, "reset web state");
  await postJsonOrThrow(`${stripeAdminUrl}/reset`, undefined, "reset mock-stripe");
  if (isMigrationScenario) {
    await postJsonOrThrow(`${migrationRunnerUrl}/__admin/reset`, undefined, "reset migration-runner");
  }
  if (isSendgridScenario) {
    await postJsonOrThrow(`${sendgridAdminUrl}/__admin/reset`, undefined, "reset mock-sendgrid");
    await postJsonOrThrow(`${webV2BaseUrl}/__admin/reset`, { runId }, "reset web-v2");
  }
  const resetServices = ["web", "loadgen", "mock-stripe"];
  if (isMigrationScenario) {
    resetServices.push("migration-runner");
  }
  if (isNotificationScenario) {
    resetServices.push("mock-notification-svc");
  }
  if (isCdnScenario) {
    resetServices.push("mock-cdn");
  }
  if (isSendgridScenario) {
    resetServices.push("mock-sendgrid", "web-v2");
  }
  events.push({
    ts: new Date().toISOString(),
    type: "run_state_reset",
    run_id: runId,
    services: resetServices
  });

  events.push({ ts: new Date().toISOString(), type: "scenario_started", scenario_id: scenarioId });

  if (scenario.loadgen && scenario.loadgen.target_url) {
    await requestJson("POST", `${loadgenControlUrl}/__admin/target`, { url: scenario.loadgen.target_url });
    events.push({ ts: new Date().toISOString(), type: "loadgen_target_set", url: scenario.loadgen.target_url });
  }
  if (scenario.traffic && scenario.traffic.baseline) {
    await requestJson("POST", `${loadgenControlUrl}/__admin/profile`, {
      profile: "baseline",
      config: scenario.traffic.baseline
    });
  }
  if (scenario.traffic && scenario.traffic.flash_sale) {
    await requestJson("POST", `${loadgenControlUrl}/__admin/profile`, {
      profile: "flash_sale",
      config: scenario.traffic.flash_sale
    });
  }

  await requestJson("POST", `${loadgenControlUrl}/__admin/profile`, { profile: "baseline" });
  events.push({ ts: new Date().toISOString(), type: "load_profile_changed", profile: "baseline" });
  const warmupSec = fastMode && scenario.fast_mode ? scenario.fast_mode.warmup_sec : scenario.runtime.warmup_sec;
  await sleep((warmupSec || 10) * 1000);

  await requestJson("POST", `${loadgenControlUrl}/__admin/profile`, { profile: "flash_sale" });
  events.push({ ts: new Date().toISOString(), type: "load_profile_changed", profile: "flash_sale" });
  const steadyStateSec = fastMode && scenario.fast_mode ? scenario.fast_mode.steady_state_sec : scenario.runtime.steady_state_sec;
  await sleep((steadyStateSec || 10) * 1000);

  let firstSymptomOracle;
  if (isMigrationScenario) {
    const action = scenario.fault_injection.action || {};
    await requestJson("POST", `${migrationRunnerUrl}${action.endpoint || "/__admin/start"}`, action.config || {});
    firstSymptomOracle = new Date().toISOString();
    events.push({
      ts: firstSymptomOracle,
      type: "fault_injected",
      target: "migration-runner",
      action: action.endpoint || "/__admin/start"
    });
  } else if (isSendgridScenario) {
    const action = scenario.fault_injection.action || {};
    const endpoint = action.endpoint || "/__admin/revoke";
    const method = action.method || "POST";
    const body = action.body || {};
    await requestJson(method, `${sendgridAdminUrl}${endpoint}`, body);
    firstSymptomOracle = new Date().toISOString();
    events.push({
      ts: firstSymptomOracle,
      type: "fault_injected",
      target: "mock-sendgrid",
      action: endpoint,
      body
    });
    await sendPlatformEventToReceiver({
      eventType: "config_change",
      timestamp: firstSymptomOracle,
      environment: "validation",
      description: "SendGrid API key rotated: key_v1 revoked, key_v2 active on new deployment",
      service: "mock-sendgrid",
      details: {
        revoked_key_prefix: "key_v1",
        scenario: "secrets_rotation_partial_propagation",
      },
    });
  } else {
    const faultAction = scenario.fault_injection.action || {};
    const faultMode = faultAction.mode || scenario.fault_injection.mode || "rate_limited";
    const faultConfig = faultAction.config || scenario.fault_injection.config || {};
    const faultModeUrlMap = {
      web: `${webBaseUrl}/__admin/mode`,
      payment_dependency: `${stripeAdminUrl}/mode`,
      "mock-stripe": `${stripeAdminUrl}/mode`,
      "mock-notification-svc": `${notificationSvcAdminUrl}/__admin/mode`
    };
    await requestJson("POST", faultModeUrlMap[faultTarget] || `${stripeAdminUrl}/mode`, {
      mode: faultMode,
      config: faultConfig
    });
    firstSymptomOracle = new Date().toISOString();
    events.push({
      ts: firstSymptomOracle,
      type: faultTarget === "web" ? "fault_injected" : "dependency_mode_changed",
      target: faultTarget,
      service: faultTarget,
      mode: faultMode
    });
  }

  const incidentMs = fastMode && scenario.fast_mode
    ? (scenario.fast_mode.incident_sec || 10) * 1000
    : (scenario.runtime.incident_sec || 10) * 1000;

  const incidentPromise = sleep(incidentMs);
  const recoveryPromise = (scenario.fault_injection && scenario.fault_injection.recovery)
    ? (async () => {
        const recovery = scenario.fault_injection.recovery;
        await sleep((recovery.at_offset_sec || 0) * 1000);
        const adminUrlMap = {
          web: webBaseUrl,
          loadgen: loadgenControlUrl,
          stripe: stripeAdminUrl,
          "migration-runner": migrationRunnerUrl,
          "mock-notification-svc": notificationSvcAdminUrl,
          "mock-sendgrid": sendgridAdminUrl,
          cdn: cdnBaseUrl
        };
        const recoveryAdminUrl = adminUrlMap[recovery.target];
        if (recoveryAdminUrl) {
          await requestJson("POST", `${recoveryAdminUrl}/__admin/mode`, {
            mode: recovery.mode,
            config: recovery.config || {}
          });
        }
        events.push({
          ts: new Date().toISOString(),
          type: "dependency_recovery",
          target: recovery.target,
          mode: recovery.mode
        });
      })()
    : Promise.resolve();

  await Promise.all([incidentPromise, recoveryPromise]);

  await requestJson("POST", `${loadgenControlUrl}/__admin/profile`, { profile: "stop" });
  events.push({ ts: new Date().toISOString(), type: "load_profile_changed", profile: "stop" });
  const cooldownSec = fastMode && scenario.fast_mode ? scenario.fast_mode.cooldown_sec : scenario.runtime.cooldown_sec;
  await sleep((cooldownSec || 5) * 1000);

  events.push({ ts: new Date().toISOString(), type: "scenario_completed", scenario_id: scenarioId });

  const metrics = await requestJson("GET", `${webBaseUrl}/metrics`);
  const loadgenState = await requestJson("GET", `${loadgenControlUrl}/__admin/state`);
  const dependencyState = isMigrationScenario
    ? await requestJson("GET", `${migrationRunnerUrl}/__admin/state`)
    : isNotificationScenario
      ? await requestJson("GET", `${notificationSvcAdminUrl}/__admin/state`)
      : isCdnScenario
        ? await requestJson("GET", `${cdnBaseUrl}/__admin/state`)
        : isSendgridScenario
          ? await requestJson("GET", `${sendgridAdminUrl}/__admin/state`)
          : await requestJson("GET", `${stripeAdminUrl}/state`);
  if (isCdnScenario) {
    events.push({ ts: new Date().toISOString(), type: "cdn_final_state", state: dependencyState.body });
  }

  fs.writeFileSync(path.join(runDir, "events.json"), JSON.stringify(events, null, 2) + "\n");
  fs.writeFileSync(
    path.join(runDir, "summary.json"),
    JSON.stringify(
      {
        scenario_id: scenarioId,
        ...buildSummary(scenario, metrics.body, loadgenState.body, dependencyState.body, events)
      },
      null,
      2
    ) + "\n"
  );

  await sleep(3000);

  const serviceLogFiles = [webLogPath, stripeLogPath, loadgenLogPath];
  if (isMigrationScenario) {
    serviceLogFiles.push(migrationLogPath);
  }
  if (isNotificationScenario) {
    serviceLogFiles.push(notificationLogPath);
  }
  if (isCdnScenario) {
    serviceLogFiles.push(cdnLogPath);
  }
  if (isSendgridScenario) {
    serviceLogFiles.push(sendgridLogPath, webV2LogPath);
  }
  const mergedServiceLogs = mergeLogFiles(serviceLogFiles);
  await normalizeCollectorJson(path.join(collectorDir, "traces.json"), path.join(runDir, "traces.json"), "[]\n");
  await normalizeCollectorJson(path.join(collectorDir, "traces.json"), path.join(runDir, "otel_traces.json"), "[]\n");
  await normalizeCollectorJson(path.join(collectorDir, "logs.jsonl"), path.join(runDir, "otel_logs.json"), "[]\n");
  await normalizeCollectorJson(path.join(collectorDir, "metrics.json"), path.join(runDir, "metrics.json"), "[]\n");
  await normalizeCollectorJson(path.join(collectorDir, "metrics.json"), path.join(runDir, "otel_metrics.json"), "[]\n");
  fs.writeFileSync(path.join(runDir, "logs.jsonl"), mergedServiceLogs);
  fs.writeFileSync(
    path.join(runDir, "platform_logs.json"),
    mergePlatformLogs(serviceLogFiles, events)
  );

  const groundTruthTemplate = JSON.parse(fs.readFileSync(groundTruthPath, "utf8"));
  const groundTruth = withOracleTimestamp(groundTruthTemplate, firstSymptomOracle);
  fs.writeFileSync(path.join(runDir, "ground_truth.json"), JSON.stringify(groundTruth, null, 2) + "\n");
  const probeInputs = collectProbeInputs(runDir);
  fs.writeFileSync(
    path.join(runDir, "scenario.probe.json"),
    JSON.stringify(buildProbeScenario(scenarioId, scenario, groundTruth, probeInputs), null, 2) + "\n"
  );

  process.stdout.write(`scenario completed: ${runDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
