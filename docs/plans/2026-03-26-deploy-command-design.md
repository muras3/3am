# Deploy Command Design

## Goal

`npx 3amoncall deploy` closes the `init → dev → demo → deploy` onboarding loop. It connects the local success experience to production by deploying the Receiver, configuring credentials, and verifying the production path works end-to-end.

## Concept

The CLI wraps platform CLIs (`vercel deploy` / `wrangler deploy`) in the Wasp pattern: delegate platform-specific deploy to the platform's own tool, layer 3amoncall-specific orchestration (credentials handoff, readiness check) on top.

`init --upgrade` is removed. All production setup goes through `deploy`.

## Flow

```
npx 3amoncall deploy

1. Preflight checks
   - Platform CLI installed (vercel / wrangler)
   - ANTHROPIC_API_KEY configured
   - Platform selection: Vercel or Cloudflare (interactive or --platform flag)

2. Platform deploy (requires user approval, --yes to skip)
   - Vercel: executes `vercel deploy --prod` internally
   - Cloudflare: executes `wrangler deploy` internally
   - Build/deploy logs streamed to terminal

3. Credentials handoff
   - Obtain Receiver URL from deploy output
   - Obtain AUTH_TOKEN (Console first-access or API)
   - Update user's app-side .env (requires approval):
     OTEL_EXPORTER_OTLP_ENDPOINT=https://<receiver-url>
     OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <token>

4. Readiness check
   - Receiver API responds (GET /api/incidents -> 200)
   - Telemetry reaches production Receiver from user's app
     (prompt user to start their app, or run production demo)

5. Completion message
   - Console URL
   - "Your app is now sending telemetry to production"
   - Next action guidance
```

## CLI Interface

```
npx 3amoncall deploy [options]

Options:
  --platform <vercel|cloudflare>  Platform selection (interactive if omitted)
  --setup                         Force first-time setup flow
  --no-setup                      Force re-deploy flow (skip setup, requires --auth-token)
  --auth-token <token>            Auth token (required with --no-setup)
  --yes                           Skip all confirmation prompts
  --no-interactive                CI mode (requires --yes + --platform)
  --json                          Output results as JSON
```

## Setup / Re-deploy Auto-detection

One command, auto-detects state via `GET /api/setup-status`:
- No flags → auto-detect (setupComplete: false → setup flow, true → redeploy flow)
- `--setup` → force setup flow (re-initialize)
- `--no-setup` → force redeploy flow (`--auth-token` required)

## AUTH_TOKEN Retrieval (Resolved)

Uses existing `GET /api/setup-token` endpoint — no Receiver changes needed.
- First deploy: CLI fetches token from `/api/setup-token` (one-time reveal, then 403)
- Re-deploy: `--auth-token` flag or credentials file

## AI / Claude Code Execution

Fully automatable: `npx 3amoncall deploy --platform vercel --yes --json`
- All steps resolve via flags or env vars
- `--json` outputs structured result for programmatic consumption

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Pattern | Wasp-style launch/deploy in one command | Auto-detect first vs subsequent deploy via setup-status API |
| Platform scope | Vercel + Cloudflare | Both are target platforms per product architecture |
| Deploy method | Wrap platform CLIs | Wasp pattern — delegate to `vercel`/`wrangler`, own the orchestration |
| AUTH_TOKEN | Existing `/api/setup-token` API | No Receiver changes. CLI fetches before Console access |
| AI execution | `--json` + `--yes` + `--platform` | Fully non-interactive, structured output |
| Credentials | Single-command flow | Modern deploy tools (Railway, Vercel) do deploy + env in one flow |
| Readiness check | Receiver health only (MVP) | GET /healthz. App exporter check is future scope |
| Approval | Before deploy + before .env write | Explicit consent for side effects, --yes for CI |
| `--upgrade` | Removed | Replaced entirely by `deploy` |

## What Deploy Is NOT

- Not a generic deployment tool. It deploys the 3amoncall Receiver only.
- Not a replacement for `vercel` or `wrangler`. It wraps them for 3amoncall-specific orchestration.
- Not responsible for deploying the user's app. It configures the user's app to point at the deployed Receiver.

## README Changes

Remove `--upgrade` references. Add `deploy` to the production section:

```bash
# Deploy Receiver to production
npx 3amoncall deploy

# Or non-interactively
npx 3amoncall deploy --platform vercel --yes
```

## Resolved Questions

1. **AUTH_TOKEN**: Use existing `GET /api/setup-token` (one-time reveal). No Receiver changes.
2. **Platform auth**: Check `vercel whoami` / `wrangler whoami`. Error with login instructions if not authenticated.
3. **Readiness check**: Receiver health only (`GET /healthz`). App exporter check is future scope.
