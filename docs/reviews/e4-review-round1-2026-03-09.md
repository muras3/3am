## E4 Code Review -- Round 1

### Summary

The E4 implementation correctly scopes auth by caller type (ADR 0028), removes all `VITE_RECEIVER_AUTH_TOKEN` references from the console bundle, and adds static SPA serving with fallback. The implementation is clean, well-tested, and closely follows the ADR. I found one major finding related to per-request synchronous I/O on the SPA fallback path, one minor auth gap in the `ALLOW_INSECURE_DEV_MODE` interaction with the ingest body limit, and a few nits. No blockers.

### Findings

#### F-E4-001: SPA fallback reads index.html from disk on every request [severity: major]
**File**: `apps/receiver/src/index.ts:57`
**Category**: performance
**Description**: The SPA fallback handler calls `readFileSync(join(consoleDist, "index.html"), "utf-8")` on every unmatched GET request. In production, `index.html` is a static file that changes only on deploy. Synchronous I/O on the hot path blocks the Node.js event loop for every client-side route navigation, 404, and browser refresh. Under moderate concurrent load this serializes all SPA requests behind disk I/O.
**Fix**: Read `index.html` once at startup and cache it in a `const`. The `try/catch` can remain at startup -- if the file is missing, either throw (fail fast) or log and skip static serving entirely. Example:
```ts
const indexHtml = (() => {
  try {
    return readFileSync(join(consoleDist, "index.html"), "utf-8");
  } catch {
    console.warn("[receiver] Console index.html not found at", consoleDist);
    return null;
  }
})();

if (indexHtml) {
  app.use("/*", serveStatic({ root: consoleDist }));
  app.get("/*", (c) => c.html(indexHtml));
}
```

#### F-E4-002: `serveStatic` root uses path string directly -- verify absolute path behavior [severity: nit]
**File**: `apps/receiver/src/index.ts:53`
**Category**: correctness
**Description**: `@hono/node-server/serve-static` uses `join(root, filename)` internally (confirmed in source). When `consoleDist` is an absolute path (e.g., `/app/dist`), `join("/app/dist", "/assets/app.js")` correctly returns `/app/dist/assets/app.js`. When it's a relative path, it resolves relative to `process.cwd()`. The library also warns at startup if the root doesn't exist (`existsSync(root)` check). The path traversal protection (`/\.\.(?:$|[\/\\])/` regex) is handled by the library itself. No action needed -- this is confirmation that the current code is correct.
**Fix**: None required. Consider adding a brief comment noting that the library handles path traversal protection.

#### F-E4-003: `readFileSync` SPA fallback does not validate `consoleDist` input [severity: minor]
**File**: `apps/receiver/src/index.ts:57`
**Category**: security
**Description**: `consoleDist` comes from `options?.consoleDist` (caller-controlled) or `process.env["CONSOLE_DIST_PATH"]` (env var). Both are operator-controlled, not user-controlled, so this is not an exploitable vulnerability. However, there is no validation that the path is absolute or points to a valid directory. If an operator accidentally sets `CONSOLE_DIST_PATH=../../../etc`, `readFileSync(join("../../../etc", "index.html"))` would attempt to read an unrelated file. The risk is very low since this is operator-configured, not user-input.
**Fix**: Optional hardening: validate that `consoleDist` is an absolute path at startup, or resolve it against `process.cwd()` explicitly. Low priority for Phase 1.

#### F-E4-004: Auth scoping is correct and well-structured [severity: nit]
**File**: `apps/receiver/src/index.ts:38-43`
**Category**: correctness
**Description**: Auth scoping review confirms:
- `/v1/*` -- Bearer required (OTel SDK ingest). Correct.
- `/api/diagnosis/*` -- Bearer required (GitHub Actions callback). Correct.
- `/api/incidents`, `/api/incidents/:id`, `/api/packets/:packetId`, `/api/chat/:id` -- no Bearer required (Console same-origin routes). Correct per ADR 0028.
- Static routes (`/`, `/assets/*`, SPA fallback) -- no auth. Correct.

The ordering is also correct: `app.use(...)` middleware is registered before `app.route(...)` routes, ensuring auth is checked before route handlers execute. Static serving is registered last, so API routes take precedence.
**Fix**: None required.

#### F-E4-005: Route shadowing analysis -- static serving cannot shadow API routes [severity: nit]
**File**: `apps/receiver/src/index.ts:46-55`
**Category**: correctness
**Description**: In Hono, `app.route("/", router)` registers the sub-router's routes with their full paths. These exact-path routes (e.g., `GET /api/incidents`) are matched before the wildcard `app.use("/*", serveStatic(...))` and `app.get("/*", fallback)`. Confirmed by:
1. Routes from `createIngestRouter` and `createApiRouter` are registered at lines 46-47, before static serving at lines 53-55.
2. `serveStatic` calls `next()` when no matching file is found on disk, and `c.finalized` check (library line 70-72) ensures it yields to already-handled responses.
3. Even if a file named `api` existed in `consoleDist`, the API route handler would execute first and set `c.finalized = true`.

No shadowing risk.
**Fix**: None required.

#### F-E4-006: Dev mode (`ALLOW_INSECURE_DEV_MODE`) correctly skips all auth middleware [severity: nit]
**File**: `apps/receiver/src/index.ts:28-44`
**Category**: correctness
**Description**: When `RECEIVER_AUTH_TOKEN` is not set and `ALLOW_INSECURE_DEV_MODE=true`, the `else` branch (lines 38-44) is never entered, so neither `/v1/*` nor `/api/diagnosis/*` get the `bearerAuth` middleware. All routes are accessible without auth. This matches the dev-mode contract. The integration tests at `integration.test.ts:195-201` and `integration.test.ts:203-207` verify this.
**Fix**: None required.

#### F-E4-007: Console `client.ts` is clean -- no token-related code remains [severity: nit]
**File**: `apps/console/src/api/client.ts:1-53`
**Category**: security
**Description**: Confirmed:
- No `VITE_RECEIVER_AUTH_TOKEN` reference anywhere in `apps/console/` (verified via grep).
- No `Authorization` header in `apiFetch` or `apiFetchPost`.
- Comment on line 1-2 documents the ADR 0028 rationale.
- `api-client.test.ts:56-68` explicitly asserts `Authorization` header is `undefined`.
**Fix**: None required.

#### F-E4-008: E2E global-setup still passes `RECEIVER_AUTH_TOKEN` to Receiver process [severity: minor]
**File**: `apps/console/e2e/global-setup.ts:70` and `apps/console/playwright.config.ts:30`
**Category**: test-coverage
**Description**: The E2E setup spawns the Receiver with `RECEIVER_AUTH_TOKEN: TOKEN` (line 70). The seed script also passes this token (line 106). The Receiver will apply Bearer auth to `/v1/*` and `/api/diagnosis/*`. The seed script calls `/v1/traces` and `/api/diagnosis/:id`, so it correctly uses the token. The Console (Vite dev server) calls `/api/*` routes (incidents, chat) through Vite proxy -- these no longer require a Bearer token per ADR 0028. This alignment is correct.

However, `playwright.config.ts:30` still sets `VITE_RECEIVER_BASE_URL=http://localhost:4319` for the Vite dev server. The Vite proxy config in `vite.config.ts:8-11` only proxies `/api` to the receiver. Routes like `/v1/*` are not proxied (nor should they be -- those are OTel SDK routes). The E2E flow should work correctly.

One gap: `playwright.config.ts` removed `VITE_RECEIVER_AUTH_TOKEN` from the webServer command, but the variable was originally there as part of the env string. Confirm that no E2E test sends `Authorization` headers from the browser context. Since the Console's `client.ts` no longer sends it, this should be fine.
**Fix**: None needed, but worth a quick manual E2E run to confirm.

#### F-E4-009: Missing test -- static serving without `consoleDist` configured [severity: minor]
**File**: `apps/receiver/src/__tests__/static-serve.test.ts`
**Category**: test-coverage
**Description**: The static-serve tests only cover the case where `consoleDist` is configured. There is no test verifying that when `consoleDist` is omitted (the default), unknown paths return 404 rather than attempting to serve static files. While this is implicitly tested by the integration tests (which don't set `consoleDist`), an explicit test in the static-serve suite would document this contract.
**Fix**: Add a test:
```ts
it("GET /unknown returns 404 when consoleDist is not configured", async () => {
  const app = createApp();
  const res = await app.request("/unknown");
  expect(res.status).toBe(404);
});
```

#### F-E4-010: Missing test -- `CONSOLE_DIST_PATH` env var fallback [severity: minor]
**File**: `apps/receiver/src/__tests__/static-serve.test.ts`
**Category**: test-coverage
**Description**: `index.ts:50` supports `CONSOLE_DIST_PATH` as an env var fallback when `options.consoleDist` is not provided. No test covers this env-var path. While the code is trivial (`options?.consoleDist ?? process.env["CONSOLE_DIST_PATH"]`), testing env-var configuration is important for deploy-time correctness.
**Fix**: Add a test that sets `process.env["CONSOLE_DIST_PATH"]` and verifies static serving works without passing `consoleDist` in options.

#### F-E4-011: ADR 0028 implementation checklist compliance [severity: nit]
**File**: `docs/adr/0028-receiver-serves-console.md:98-104`
**Category**: correctness
**Description**: Checking each item:
- [x] `app.use("*", bearerAuth(...))` changed to `app.use("/v1/*", bearerAuth(...))` -- Done (line 42). Also added `/api/diagnosis/*` protection (line 43), which goes beyond the ADR spec but is correct for the security model.
- [x] `serveStatic` for `dist/` at `/` -- Done (line 53).
- [x] SPA fallback (`/*` -> `dist/index.html`) -- Done (lines 55-62).
- [x] `VITE_RECEIVER_AUTH_TOKEN` removed from `client.ts` -- Done (no references remain).
- [x] Vite proxy config unchanged -- Confirmed (`vite.config.ts` proxy config intact).
- [x] Tests: `GET / -> index.html` and `GET /api/incidents -> works without Bearer` -- Done.
- [x] `grep -r VITE_RECEIVER_AUTH_TOKEN apps/console/dist/` returns nothing -- Not explicitly automated, but source is clean; grep on `apps/console/` confirms zero matches.

All checklist items satisfied.
**Fix**: None required.

#### F-E4-012: `bodyLimit` middleware in ingest router does not leak to static routes [severity: nit]
**File**: `apps/receiver/src/transport/ingest.ts:21-27`
**Category**: correctness
**Description**: The `bodyLimit` middleware at `ingest.ts:21` uses `app.use("*", bodyLimit(...))` inside the `createIngestRouter()` sub-router. Since this sub-router only defines routes under `/v1/*`, the body limit only applies to those paths. Static GET requests and `/api/*` routes are unaffected. Correct behavior confirmed.
**Fix**: None required.

### Overall verdict

**APPROVE** -- The implementation is clean, follows ADR 0028 faithfully, and the auth scoping is correct. The major finding (F-E4-001, `readFileSync` per request) should be addressed before production deployment but is not a blocker for merging to develop. The minor test coverage gaps (F-E4-009, F-E4-010) are nice-to-haves. No security vulnerabilities found.
