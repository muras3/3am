# 3amoncall

Diagnose serverless app incidents in under 5 minutes using OTel data + LLM.

---

## Quick Start (Local)

**Prerequisites:** Docker Desktop, Node.js 18+, plus one LLM path:

- `automatic` mode: `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`
- `manual` mode: local `claude`, local `codex`, local Ollama, or an API key-backed provider

```bash
# 1. Set up OTel SDK in your app
npx 3amoncall init

# 2. Start local Receiver (requires Docker Desktop)
npx 3amoncall local

# 2b. If you selected manual mode, start the local bridge
npx 3amoncall bridge

# 3. (In another terminal) Run a demo incident — see diagnosis in action
npx 3amoncall local demo

# 4. Open Console to see the diagnosis
open http://localhost:3333
```

`3amoncall local demo` injects a synthetic downstream-timeout scenario into the local Receiver and runs a real LLM diagnosis (~¥10/run). No real incident needed — you see the full diagnosis and AI copilot experience immediately. Demo data uses `service.name=3amoncall-demo` and won't mix with your app's telemetry.

`3amoncall init` is runtime-aware. For Node.js and Vercel it installs OTel dependencies, creates `instrumentation.ts/js`, and writes `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3333` to `.env`. For Cloudflare Workers it updates `wrangler.toml` or `wrangler.jsonc` to enable Workers Observability for traces and logs.

`3amoncall init` now captures a diagnosis mode and provider choice.

- `automatic`: Receiver runs diagnosis server-side
- `manual`: Console and CLI route diagnosis through the local bridge, so you can use Claude Code, Codex, Ollama, or another local/provider-backed setup without issuing an Anthropic API key

`3amoncall local` pulls and runs the Receiver image via Docker. In manual mode, also start `npx 3amoncall bridge` so Console-triggered local diagnosis can reach your local provider.

You can also run manual diagnosis directly from the CLI:

```bash
npx 3amoncall diagnose \
  --incident-id inc_000001 \
  --receiver-url http://localhost:3333 \
  --provider claude-code
```

For your own app telemetry, start your app with instrumentation loaded:

```bash
node --require ./instrumentation.js your-app.js
```

Optional receiver tuning:
- `RETENTION_HOURS=48` controls raw telemetry retention, incident auto-close after inactivity, and hard-delete delay for closed incidents. The same window is used for all three.

**Note:** Logs require a structured logger (pino, winston, or bunyan) wired through `@opentelemetry/auto-instrumentations-node`. `console.log` is not captured.

---

## Deploy to Vercel (Production)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/3amoncall/3amoncall&env=ANTHROPIC_API_KEY&envDescription=Anthropic%20API%20key%20for%20LLM%20diagnosis&envLink=https://console.anthropic.com/settings/keys&products=%5B%7B%22type%22%3A%22integration%22%2C%22group%22%3A%22postgres%22%7D%5D&project-name=3amoncall&repository-name=3amoncall)

1. Click the button above
2. Choose `automatic` or `manual` diagnosis mode for the deployment
3. If you want server-side automatic diagnosis, set `ANTHROPIC_API_KEY` or another supported server-side provider credential
4. Neon Postgres is auto-provisioned via the Vercel integration
5. Set `RETENTION_HOURS` in your deployment environment if you need a window other than 48 hours
6. After deploy, open your Console URL — the first-access screen displays your `AUTH_TOKEN`
7. Point your app at the production Receiver:

```bash
npx 3amoncall deploy vercel

# Or non-interactively (for CI / Claude Code):
npx 3amoncall deploy vercel --yes --no-interactive --json
```

---

## Self-Instrumentation

3amoncall can emit OpenTelemetry about the receiver itself in addition to ingesting telemetry from your application.

- Vercel and local Node.js are the supported self-instrumentation targets.
- Cloudflare Workers self-instrumentation is experimental and uses Cloudflare's official automatic tracing and logging path.
- Capability is intentionally not symmetric across platforms.
- Self telemetry should go to a dedicated OTLP backend, or to a separate 3amoncall environment reserved for dogfooding. Do not point it at the same receiver ingest endpoint that is handling your application telemetry.

### Platform Matrix

| Platform | Status | Traces | Logs | Metrics | How it works |
|----------|--------|--------|------|---------|--------------|
| Vercel / Node.js | Supported | Yes | Yes | Not implemented | Receiver starts a Node OpenTelemetry SDK and exports its own HTTP and fetch activity to your OTLP endpoint |
| Cloudflare Workers | Experimental | Yes | Yes | Not supported | Cloudflare Workers Observability automatic tracing and invocation logging are enabled in `wrangler.toml` |

### Vercel / Node.js Setup

Set these environment variables for the receiver deployment:

```bash
SELF_OTEL_ENABLED=true
SELF_OTEL_EXPORTER_OTLP_ENDPOINT=https://your-otel-backend.example.com
SELF_OTEL_SERVICE_NAME=3amoncall-receiver
SELF_OTEL_SERVICE_NAMESPACE=3amoncall
SELF_OTEL_DEPLOYMENT_ENVIRONMENT=production
```

Optional:

```bash
SELF_OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer your-token,x-tenant=dogfood
SELF_OTEL_CONSOLE_LOGS=true
```

What is emitted on Node/Vercel:

- inbound receiver HTTP requests such as `/healthz`, `/v1/traces`, and `/api/*`
- outbound `fetch` and Undici requests made by the receiver runtime
- receiver request completion logs with HTTP method, path, status, and duration

### Cloudflare Workers Setup

Cloudflare Workers support is experimental. The receiver enables Workers Observability in [`apps/receiver/wrangler.toml`](/Users/murase/project/3amoncall-self-instrumentation/apps/receiver/wrangler.toml), which is the intended path for automatic tracing and log capture on Workers.

- traces: supported
- logs: supported
- metrics: not supported for receiver self-instrumentation
- custom spans: not a pre-release requirement and not implemented here

For deployment and verification details, see [`docs/self-instrumentation.md`](/Users/murase/project/3amoncall-self-instrumentation/docs/self-instrumentation.md).

### User Telemetry vs 3amoncall Self Telemetry

- user telemetry is the telemetry your application sends to the 3amoncall receiver via `/v1/traces`, `/v1/logs`, and `/v1/metrics`
- self telemetry is the telemetry emitted by the 3amoncall receiver process or worker about its own requests and internal activity

Use separate destinations, projects, or tenants so dogfooding data does not pollute the incident stream you are analyzing for your application.

---

## How It Works

```
Your App (OTel SDK)
  → Receiver (OTLP ingest, anomaly detection, incident packet formation)
  → LLM diagnosis
    → automatic mode: inline in Receiver
    → manual mode: local bridge / CLI, then persisted back to Receiver
  → Console (incident board, evidence explorer, AI copilot)
```

The Receiver collects spans, metrics, and logs via OTLP/HTTP. When anomaly thresholds are crossed, it forms an incident packet. In `automatic` mode, it resolves a server-side provider and runs diagnosis inline. In `manual` mode, Console and CLI actions trigger local execution through the bridge and post the results back. Results are surfaced in the Console in both modes.

---

## Configuration

### Retention

Set `RETENTION_HOURS` to control how long telemetry data (spans, metrics, logs, snapshots) and closed incidents are kept. Default: `1` (1 hour). Cleanup is app-side lazy cleanup, triggered by incoming requests at most once every 5 minutes.

| `RETENTION_HOURS` | Retention |
|-------------------|-----------|
| `1` (default)     | 1 hour    |
| `24`              | 24 hours  |
| `72`              | 72 hours  |

Invalid values (non-integer, zero, negative) fall back to the default (1 hour). Open incidents are never deleted by cleanup regardless of retention.

---

## Notification Setup

3amoncall can post a message to a Slack or Discord channel when an incident is detected.

### Slack Incoming Webhook

1. Go to https://api.slack.com/apps → "Create New App" → "From Scratch"
2. Name the app (e.g. "3amoncall") and select your workspace
3. Under "Incoming Webhooks" → toggle ON → "Add New Webhook to Workspace" → select channel
4. Copy the webhook URL (starts with `https://hooks.slack.com/services/...`)

### Discord Webhook

1. In Discord, go to Server Settings → Integrations → Webhooks → "New Webhook"
2. Name it (e.g. "3amoncall") and select the target channel
3. Copy the webhook URL (starts with `https://discord.com/api/webhooks/...`)

### Configuration

```bash
# Set via environment variable
export NOTIFICATION_WEBHOOK_URL="https://hooks.slack.com/services/..."

# Or configure during init
npx 3amoncall init
```

### How It Works

- When an incident is detected, 3amoncall sends a notification to the configured webhook
- The notification includes: incident ID, severity, affected service, trigger signals, and a link to the console
- Notifications are fire-and-forget — they never block incident processing
- Only Slack and Discord webhook URLs are supported (validated by hostname)

---

## Security

- **Anthropic spending limit:** Set a monthly spend cap at [console.anthropic.com](https://console.anthropic.com/settings/billing) before deploying. Diagnosis runs on every incident.
- **AUTH_TOKEN:** Stored in `localStorage` after first access. To recover it, check the `RECEIVER_AUTH_TOKEN` environment variable in your Vercel project settings.
- **ANTHROPIC_API_KEY:** Stored as a Vercel environment variable (server-side only, never exposed to the browser).
