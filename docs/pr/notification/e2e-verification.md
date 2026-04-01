# E2E Notification Verification — 2026-04-01

## Test method

Real receiver process started with `NOTIFICATION_WEBHOOK_URL` set.
OTLP error spans sent via `POST /v1/traces` to trigger incident creation.
Full pipeline: OTLP ingest → anomaly detection → incident creation → `void notifyIncidentCreated()` → Slack/Discord webhook POST.

## Slack test

- **Receiver config**: `NOTIFICATION_WEBHOOK_URL=https://hooks.slack.com/services/T.../B.../...`
- **OTLP span**: service=checkout-api, env=production, status=ERROR, route=/checkout, HTTP 500
- **Ingest response**: `{"status":"ok","incidentId":"inc_000001","packetId":"b7b55158-..."}`
- **Webhook result**: HTTP 200 (Slack accepted the payload)
- **Channel**: Notification received in Slack channel (see screenshot)

## Discord test

- **Receiver config**: `NOTIFICATION_WEBHOOK_URL=https://discordapp.com/api/webhooks/...`
- **OTLP span**: service=payment-svc, env=staging, status=ERROR, route=/pay, HTTP 502
- **Ingest response**: `{"status":"ok","incidentId":"inc_000001","packetId":"3948f446-..."}`
- **Webhook result**: HTTP 204 (Discord accepted the payload)
- **Channel**: Notification received in Discord #通知 channel (see screenshot)

## What was verified

1. URL detection: `hooks.slack.com` → slack, `discordapp.com` → discord
2. Payload formatting: Block Kit (Slack), Embed (Discord) — both accepted by platform
3. Full pipeline: OTLP span → ingest → incident → notification (no direct formatter call)
4. Fire-and-forget: ingest returned 200 before notification completion
5. Console link: `http://localhost:3333/incidents/inc_000001` included in notification

## What was NOT verified (requires manual check)

- Console link click → actual incident page navigation (localhost not publicly routed)
- Notification appearance/rendering in Slack/Discord clients (awaiting user screenshots)
