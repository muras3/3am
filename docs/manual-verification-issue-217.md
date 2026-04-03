# Issue #217 Manual Verification

## Local automatic mode

1. Run `npx 3am init --mode automatic --provider anthropic`.
2. Start Receiver with `npx 3am local`.
3. Trigger a demo incident with `npx 3am local demo`.
4. Open `http://localhost:3333`.
5. Confirm the incident board shows stage 1 + stage 2 output without starting the bridge.

## Local manual mode with Claude Code / Codex / Ollama

1. Run `npx 3am init --mode manual --provider claude-code`.
2. Start Receiver with `npx 3am local`.
3. Start the local bridge with `npx 3am bridge`.
4. Trigger a demo incident or ingest your own telemetry.
5. In Console, open the incident and trigger re-run diagnosis.
6. Confirm the board refreshes with updated diagnosis and narrative.

## CLI-driven manual diagnosis

1. Ensure Receiver is running and you have an incident id.
2. Run:

```bash
npx 3am diagnose \
  --incident-id inc_000001 \
  --receiver-url http://localhost:3333 \
  --provider codex
```

3. Reload Console and confirm the incident now contains diagnosis + narrative.

## Receiver settings API

1. Call `GET /api/settings/diagnosis`.
2. Confirm `mode`, `provider`, and `bridgeUrl` match the selected setup.
3. Call `PUT /api/settings/diagnosis` to switch between `automatic` and `manual`.
4. Confirm Console behavior follows the updated mode.
