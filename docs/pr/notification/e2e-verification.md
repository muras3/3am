# E2E Notification Verification

This document captures the current production-shape notification behavior for OSS/self-hosted 3am.

## Integration model

- Slack: user-owned Slack app + bot token
- Discord: user-owned Discord bot for threaded delivery
- 3am stores those credentials in the Receiver and automates parent notification + threaded follow-up after setup

## Slack verification

### API connectivity

`chat.postMessage(channel=C0AQ04B1RK5)` returned:

- `ok: true`
- `channel: C0AQ04B1RK5`
- `ts: 1776075386.282879`

### Thread verification

Parent message:

- `ts: 1776075532.044279`
- `text: [HIGH] Incident inc_slack_verify. Diagnosing now.`

Follow-up message:

- `ts: 1776075532.352089`
- `thread_ts: 1776075532.044279`
- `parent_user_id: U0AQ33SJWKF`

Result: Slack follow-up was posted into the same thread as the parent incident message.

## Discord verification

### Webhook connectivity

Webhook POST returned:

- `status: 200`
- `channel_id: 1488797264653586472`
- `id: 1493184936008745061`

This verifies webhook delivery only. It does **not** satisfy the "single thread per incident" requirement.

### Bot thread verification

Bot parent message:

- `status: 200`
- `id: 1493206572418207894`
- `channel_id: 1488797264653586472`

Thread creation from parent message:

- `status: 201`
- `type: 11`
- `id: 1493206572418207894`
- `parent_id: 1488797264653586472`

Follow-up in thread:

- `status: 200`
- `id: 1493206577262624838`
- `channel_id: 1493206572418207894`

Result: Discord created a real thread from the parent incident message and the diagnosis follow-up was posted inside that thread.

## Product conclusion

For OSS/self-hosted 3am, the correct integration pattern is:

1. user creates Slack app / Discord bot once
2. user provides the resulting bot credentials to `npx 3am integrations notifications`
3. 3am verifies connectivity and stores them
4. 3am fully automates threaded incident delivery from then on

This is the highest-leverage automation level that does not require a centrally hosted vendor-managed app.
