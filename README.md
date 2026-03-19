# 3amoncall

Diagnose serverless app incidents in under 5 minutes using OTel data + LLM.

---

## Quick Start (Local)

**Prerequisites:** Docker Desktop, Node.js 18+

```bash
# 1. Set up OTel SDK in your app
npx 3amoncall init

# 2. Start local Receiver (requires Docker Desktop)
npx 3amoncall dev

# 3. Start your app (with OTel instrumentation loaded)
node --require ./instrumentation.js your-app.js

# 4. Open Console
open http://localhost:3333
```

`3amoncall init` installs OTel dependencies, creates `instrumentation.ts/js`, and writes `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3333` to `.env`.

`3amoncall dev` pulls and runs the Receiver image via Docker. Set `ANTHROPIC_API_KEY` in your `.env` or environment before running — LLM diagnosis requires it.

**Note:** Logs require a structured logger (pino, winston, or bunyan) wired through `@opentelemetry/auto-instrumentations-node`. `console.log` is not captured.

---

## Deploy to Vercel (Production)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/3amoncall/3amoncall&env=ANTHROPIC_API_KEY&envDescription=Anthropic%20API%20key%20for%20LLM%20diagnosis&envLink=https://console.anthropic.com/settings/keys&products=%5B%7B%22type%22%3A%22integration%22%2C%22group%22%3A%22postgres%22%7D%5D&project-name=3amoncall&repository-name=3amoncall)

1. Click the button above
2. Enter your `ANTHROPIC_API_KEY` — this is the only value you need to provide
3. Neon Postgres is auto-provisioned via the Vercel integration
4. After deploy, open your Console URL — the first-access screen displays your `AUTH_TOKEN`
5. Point your app at the production Receiver:

```bash
npx 3amoncall init --upgrade
# Prompts for: Receiver URL + AUTH_TOKEN
```

---

## How It Works

```
Your App (OTel SDK)
  → Receiver (OTLP ingest, anomaly detection, incident packet formation)
  → LLM diagnosis (Anthropic Claude, inline in Receiver)
  → Console (incident board, evidence explorer, AI copilot)
```

The Receiver collects spans, metrics, and logs via OTLP/HTTP. When anomaly thresholds are crossed, it forms an incident packet and runs LLM diagnosis inline. Results are surfaced in the Console.

---

## Security

- **Anthropic spending limit:** Set a monthly spend cap at [console.anthropic.com](https://console.anthropic.com/settings/billing) before deploying. Diagnosis runs on every incident.
- **AUTH_TOKEN:** Stored in `localStorage` after first access. To recover it, check the `RECEIVER_AUTH_TOKEN` environment variable in your Vercel project settings.
- **ANTHROPIC_API_KEY:** Stored as a Vercel environment variable (server-side only, never exposed to the browser).
