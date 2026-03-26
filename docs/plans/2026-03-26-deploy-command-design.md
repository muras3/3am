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
  --yes                           Skip all confirmation prompts
  --no-interactive                CI mode (requires --yes)
```

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Platform scope | Vercel + Cloudflare | Both are target platforms per product architecture |
| Deploy method | Wrap platform CLIs | Wasp pattern — delegate to `vercel`/`wrangler`, own the orchestration |
| Credentials | Single-command flow | Modern deploy tools (Railway, Vercel) do deploy + env in one flow |
| Readiness check | Receiver + app exporter | Verify the production path works, not just that Receiver is up |
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

## Open Questions for Implementation

1. How to obtain AUTH_TOKEN programmatically after deploy (currently shown in Console first-access screen)
2. Whether to support `vercel link` / `wrangler login` detection or require pre-auth
3. Exact readiness check for "telemetry reaches production" — prompt user to start app + poll, or run remote demo
