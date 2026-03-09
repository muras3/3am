# ADR 0028 — Receiver Serves Console (Same-Origin BFF Pattern)

**Status**: Accepted
**Date**: 2026-03-09
**Deciders**: @muras3

---

## Context

Phase D shipped the Console as a standalone Vite SPA that calls the Receiver API from the browser. The auth token (`VITE_RECEIVER_AUTH_TOKEN`) was baked into the client bundle at build time. This was explicitly flagged as dev/preview only (ADR 0011) — anyone with the bundle can extract the token.

Phase E needs a production-safe auth model before any real deployment.

## Decision

**Receiver serves the Console's static build and owns auth entirely, with path-scoped middleware.**

### Auth model

Current state (Phase D):
```
app.use("*", bearerAuth({ token }))   ← all routes require Bearer token
```

E4 target:
```
app.use("/v1/*", bearerAuth({ token }))  ← ingest routes require Bearer token
# /api/* routes require no Bearer token from browser
```

This splits auth by caller type:
- `/v1/*` (OTel ingest) — called by the application's OTel SDK. Requires Bearer token. SDK credentials stay server-to-server.
- `/api/*` (Console API) — called by the same-origin Console SPA. No Bearer token required from browser. Protection comes from same-origin serving: the browser can only reach `/api/*` if it loaded the Console from the Receiver itself.
- `/` and static assets — no auth. HTML/JS/CSS contain no secrets.

### Serving

- After `pnpm --filter @3amoncall/console build`, Receiver serves `apps/console/dist/` at `/`.
- `/*` (non-API, non-ingest) falls through to `dist/index.html` (SPA client-side routing).
- Static routes are mounted outside the auth middleware.

### Auth flow

```
Browser → GET /          → Receiver serves dist/index.html (no auth check)
Browser → GET /assets/*  → Receiver serves dist/assets/*  (no auth check)
Browser → GET /api/*     → Hono /api/* routes (no Bearer required — same-origin protection)
OTel SDK→ POST /v1/*     → Hono /v1/* routes (Bearer auth required)
```

The Bearer token (`RECEIVER_AUTH_TOKEN`) never appears in:
- The browser bundle
- Network responses to the browser
- Any `window.*` or `localStorage` location

### Console changes

- `VITE_RECEIVER_AUTH_TOKEN` removed from `apps/console/src/api/client.ts`.
- No `Authorization` header sent from browser.
- In dev, Vite proxy (`/api → localhost:4318`) forwards requests to Receiver. Receiver in dev mode sets `ALLOW_INSECURE_DEV_MODE=true` (no Bearer check on `/v1/*` is a separate concern).

## Alternatives considered

### A: Server-side Bearer injection proxy (BFF layer)
Add a `/bff/*` path where the Receiver injects the Bearer token and forwards to `/api/*` internally.

Rejected for Phase 1 — adds a routing indirection with no security benefit over path-scoped middleware. The protection is same-origin serving, not the token itself. Can revisit if multi-tenant auth is needed later.

### B: `/api/token` endpoint returns short-lived token to browser
Rejected — token still reaches the browser. Same exposure as Phase D, just shorter-lived.

### C: Cookie-based session with server-side token exchange
Rejected — adds cookie management complexity, CSRF surface, and session state for Phase 1 with a single-operator use case.

### D: Separate reverse proxy (nginx, Cloudflare Worker)
Rejected — adds operational complexity. Hono can serve static files natively via `serveStatic`.

## Security model and scope

This model is appropriate for **personal and small-team deployments** where:
- The Receiver is not exposed to the public internet (or is behind a firewall/VPN), OR
- Operators accept that `/api/*` is accessible to anyone who can reach the host — the data is incident data, not user credentials.

For multi-tenant or public deployments, a per-user auth layer would be needed. That is out of scope for Phase 1.

## Consequences

- **Positive**: No browser token extraction surface — Bearer token stays server-side only.
- **Positive**: Single binary/process to deploy.
- **Positive**: SPA routing and API auth handled in one place.
- **Neutral**: `/api/*` is accessible without Bearer auth — intentional; same-origin serving is the access gate.
- **Negative**: Build order matters: `@3amoncall/console` must build before Receiver can serve Console.
- **Negative**: In dev, Console still runs as a separate Vite dev server (Vite proxy handles `/api`).

## Implementation checklist

- [ ] `apps/receiver/src/index.ts`: change `app.use("*", bearerAuth(...))` → `app.use("/v1/*", bearerAuth(...))`
- [ ] `apps/receiver/src/index.ts`: add `serveStatic` for `dist/` at `/`
- [ ] `apps/receiver/src/index.ts`: add SPA fallback (`/*` → `dist/index.html`)
- [ ] `apps/console/src/api/client.ts`: remove `VITE_RECEIVER_AUTH_TOKEN` and `Authorization` header
- [ ] `apps/console/vite.config.ts`: verify Vite proxy config unchanged (already correct)
- [ ] `apps/receiver/src/__tests__/static-serve.test.ts`: GET `/` → index.html; GET `/api/incidents` → works without Bearer
- [ ] Verify: `grep -r VITE_RECEIVER_AUTH_TOKEN apps/console/dist/` returns nothing after build
