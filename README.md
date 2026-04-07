<p align="center">
  <a href="https://github.com/muras3/3am">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logo-horizontal-dark.svg"/>
      <img src="assets/logo-horizontal.svg" alt="3am" height="48"/>
    </picture>
  </a>
</p>

<p align="center">Incident diagnosis for serverless apps</p>

<p align="center">
  <a href="https://github.com/muras3/3am/actions/workflows/ci.yml"><img src="https://github.com/muras3/3am/actions/workflows/ci.yml/badge.svg?branch=develop" alt="CI"/></a>
  <a href="https://www.npmjs.com/package/3amoncall"><img src="https://img.shields.io/npm/v/3amoncall.svg" alt="npm"/></a>
  <a href="#license"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License"/></a>
</p>

---

OTel data in → diagnosis + action plan out. No thresholds. No runbooks. Under 60 seconds.

```
ROOT CAUSE HYPOTHESIS
  Checkout-orchestrator retries payment 429s at fixed 100ms intervals
  without backoff → saturates the 16-worker pool → 504s cascade to
  all routes behind it.

CAUSAL CHAIN
  1. Flash sale spike increases checkout demand
  2. Payment provider returns 429 (rate limited)
  3. App retries immediately — fixed interval, no backoff
  4. Worker pool saturates → queue depth hits 216
  5. All routes behind the pool start timing out
  6. 504s cascade to /checkout and /orders/:id

NEXT OPERATOR STEP
  ✓ Disable retries to the payment dependency
  ✓ Add exponential backoff or circuit breaker
  ✓ Shed non-critical checkout work to free workers

AVOID ASSUMING
  ✗ Database is the bottleneck — connections stable, no latency spike
  ✗ Recent deploy caused this — unrelated to concurrency config
  ✗ Scaling the DB will help — confirm bottleneck first
```

<sup>Output from a <a href="validation/scenarios/third_party_api_rate_limit_cascade/">validated scenario</a> — tested against <a href="validation/scenarios/">5 incident types</a>.</sup>

<p align="center">
  <img src="assets/frames/frame_0002.png" alt="3am Console — incident diagnosis" width="720"/>
</p>

---

## Quick Start

```bash
npx 3am init          # instrument your app with OTel
npx 3am local         # start local receiver (Docker)
npx 3am local demo    # inject a demo incident → see diagnosis
```

Open **http://localhost:3333**. Requires Docker Desktop and Node.js 18+.

<details>
<summary>What each command does</summary>

**`3am init`** detects your runtime and sets up OTel automatically:
- **Node.js / Vercel** — installs OTel deps, creates `instrumentation.ts`, writes OTLP endpoint to `.env`
- **Cloudflare Workers** — updates `wrangler.toml` to enable Workers Observability

**`3am local demo`** injects a synthetic incident and runs a real LLM diagnosis (~¥10/run). Demo data uses `service.name=3am-demo` — won't mix with your telemetry.

**Diagnosis modes:**
- **automatic** — receiver runs diagnosis server-side (needs API key)
- **manual** — route diagnosis through Claude Code, Codex, or Ollama locally (no API key needed)

</details>

---

## Deploy

| | Command | What you get |
|---|---|---|
| [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/muras3/3am&env=ANTHROPIC_API_KEY&products=%5B%7B%22type%22%3A%22integration%22%2C%22group%22%3A%22postgres%22%7D%5D&project-name=3am) | `npx 3am deploy vercel` | Neon Postgres auto-provisioned, `AUTH_TOKEN` on first access |
| **Cloudflare** | `npx 3am deploy cloudflare` | D1 storage, Workers Observability integration |

---

## How It Works

```
Your App ──OTel──→ Receiver ──→ LLM ──→ Console
              spans, logs,    anomaly     root cause,    incident board,
              metrics         detection   action plan    evidence explorer
```

The receiver ingests OTLP/HTTP telemetry. When anomalies cross thresholds, it forms an **incident packet** — a structured snapshot of what's wrong — and feeds it to an LLM. No thresholds to configure. No rules to write.

**LLM provider auto-detection** — uses whatever's available, no config needed:

| Priority | Provider | Detection |
|----------|----------|-----------|
| 1 | Anthropic | `ANTHROPIC_API_KEY` in env |
| 2 | Claude Code | `claude` CLI in PATH |
| 3 | Codex | `codex` CLI in PATH |
| 4 | OpenAI | `OPENAI_API_KEY` in env |
| 5 | Ollama | Running on localhost:11434 (free, local) |

---

## More

<details>
<summary><strong>Configuration</strong> — retention, notifications, logging</summary>

### Retention

`RETENTION_HOURS` controls how long telemetry and closed incidents are kept. Default: `1` hour.

Open incidents are never deleted regardless of retention setting.

### Notifications

```bash
export NOTIFICATION_WEBHOOK_URL="https://hooks.slack.com/services/..."
```

Posts to Slack or Discord when an incident is detected. Fire-and-forget — never blocks incident processing.

### Logs

Requires a structured logger (pino, winston, bunyan) wired through `@opentelemetry/auto-instrumentations-node`. `console.log` is not captured.

</details>

<details>
<summary><strong>Security</strong></summary>

- Set an [Anthropic spending limit](https://console.anthropic.com/settings/billing) before deploying — diagnosis runs on every incident
- `AUTH_TOKEN` is stored in `localStorage` after first access. Recover from `RECEIVER_AUTH_TOKEN` in your deployment env vars
- API keys are server-side only, never exposed to the browser

</details>

<details>
<summary><strong>CLI reference</strong></summary>

```bash
npx 3am init                                    # set up OTel in your app
npx 3am local                                   # start local receiver
npx 3am local demo                              # run demo incident
npx 3am deploy vercel|cloudflare                # deploy to platform
npx 3am diagnose --incident-id inc_000001       # manual diagnosis
npx 3am bridge                                  # start local diagnosis bridge
```

</details>

<sub><a href="llms-full.txt">AI agents: read llms-full.txt for machine-readable setup instructions</a></sub>

---

## License

Apache-2.0 — see [LICENSE](LICENSE).
