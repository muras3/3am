# Deploy Command Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `npx 3amoncall deploy` — deploy the Receiver to Vercel or Cloudflare, configure credentials, and verify the production path works.

**Architecture:** Wrap platform CLIs (`vercel deploy --prod` / `wrangler deploy`) via `node:child_process.spawn` with `stdio: "inherit"` for log streaming. Layer 3amoncall-specific orchestration (credentials handoff, readiness check) on top. No new npm dependencies — use Node built-ins only.

**Design doc:** `docs/plans/2026-03-26-deploy-command-design.md`

**Reference implementation:** `packages/cli/src/commands/demo.ts` — follow its patterns for options interface, error handling (`process.stderr.write` + `process.exit(1)`), spinner, confirm prompts, and `process.stdout.write` for all output.

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Subprocess spawning | `child_process.spawn` with `stdio: "inherit"` | Stream build/deploy logs directly to terminal |
| Platform CLI detection | Run `which vercel` / `which wrangler` via `execFileSync` | Simplest check — fails fast with clear error |
| Platform auth check | Run `vercel whoami` / `wrangler whoami` | Detects login state before attempting deploy |
| Receiver URL extraction | Parse stdout of deploy command (Vercel prints URL) | No API calls needed; for Cloudflare, parse wrangler output or prompt |
| AUTH_TOKEN | Prompt user to copy from Console first-access screen | Open question — programmatic retrieval not yet available |
| .env update | Append/update `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` | Requires user approval before writing |
| Readiness check | `GET /api/incidents?limit=1` on deployed Receiver → 200 | Same check as `demo.ts:checkReceiver` — extract and share |
| `--upgrade` removal | Delete from README, no CLI changes needed | `init --upgrade` was never registered in cli.ts |

## Open Questions (deferred, not blockers)

1. **AUTH_TOKEN programmatic retrieval** — currently manual (Console first-access). Future: Console API.
2. **Telemetry arrival verification** — plan implements Receiver health check only. App-side exporter check is future scope with a concrete ticket, not "Phase 2".

---

## Task 1: Platform detection utilities

**Files:**
- Create: `packages/cli/src/commands/deploy/platform.ts`
- Test: `packages/cli/src/__tests__/deploy-platform.test.ts`

**What to build:**
- `detectPlatformCli(platform: "vercel" | "cloudflare"): boolean` — uses `execFileSync("which", ["vercel"])` (or `"wrangler"`) in a try/catch. Returns true/false.
- `checkPlatformAuth(platform: "vercel" | "cloudflare"): Promise<boolean>` — runs `vercel whoami` / `wrangler whoami` via `execFile`. Returns true if exit code 0.
- `promptPlatformSelection(): Promise<"vercel" | "cloudflare">` — readline prompt with `[1] Vercel  [2] Cloudflare` choices.

**Test strategy:**
- Mock `child_process.execFileSync` / `execFile` to test detection without real CLIs
- Test: CLI found → true, CLI not found (throws) → false
- Test: auth check passes → true, auth check fails → false
- Platform selection: mock readline, verify both choices

**Commit:** `feat(cli): add platform detection utilities for deploy command`

---

## Task 2: Deploy executor (subprocess wrapper)

**Files:**
- Create: `packages/cli/src/commands/deploy/executor.ts`
- Test: `packages/cli/src/__tests__/deploy-executor.test.ts`

**What to build:**
- `runPlatformDeploy(platform: "vercel" | "cloudflare"): Promise<{ url: string }>` — spawns `vercel deploy --prod` or `wrangler deploy` with `stdio: ["inherit", "pipe", "inherit"]` (pipe stdout to capture URL, inherit stderr for build logs). Parses deployment URL from stdout. Rejects on non-zero exit.

**Design notes:**
- Vercel prints the deployment URL on stdout (e.g., `https://my-project-xxx.vercel.app`)
- Wrangler prints `Published ... (https://my-worker.my-domain.workers.dev)`
- Parse with simple regex per platform
- Also pipe stdout to process.stdout so user sees logs (tee pattern)

**Test strategy:**
- Mock `child_process.spawn` — return mock ChildProcess with fake stdout events
- Test: Vercel output → correct URL extracted
- Test: Wrangler output → correct URL extracted
- Test: Non-zero exit → rejects with error
- Test: No URL in output → rejects with descriptive error

**Commit:** `feat(cli): add deploy executor with URL extraction`

---

## Task 3: Credentials handoff (.env updater)

**Files:**
- Create: `packages/cli/src/commands/deploy/env-writer.ts`
- Test: `packages/cli/src/__tests__/deploy-env-writer.test.ts`

**What to build:**
- `updateAppEnv(options: { receiverUrl: string; authToken: string; envPath?: string; dryRun?: boolean }): { added: string[]; updated: string[] }` — reads existing `.env`, updates or appends `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS`, writes back. Returns what changed.
- `promptAuthToken(): Promise<string>` — readline prompt for user to paste AUTH_TOKEN from Console.

**Design notes:**
- Default `envPath` = `.env` in `process.cwd()`
- If `.env` doesn't exist, create it
- Preserve existing lines; only touch the two OTEL keys
- `OTEL_EXPORTER_OTLP_HEADERS` format: `Authorization=Bearer <token>`
- `dryRun: true` returns changes without writing (for preview before approval)

**Test strategy:**
- Use temp directory with `fs.mkdtempSync` for real file I/O tests
- Test: empty .env → both keys added
- Test: existing .env with unrelated vars → keys appended, existing vars preserved
- Test: existing OTEL keys → updated in place
- Test: dryRun → returns changes but file unchanged
- Test: no .env file → created

**Commit:** `feat(cli): add .env writer for deploy credentials handoff`

---

## Task 4: Readiness check

**Files:**
- Modify: `packages/cli/src/commands/demo.ts` — extract `checkReceiver` to shared location
- Create: `packages/cli/src/commands/shared/health.ts`
- Test: `packages/cli/src/__tests__/deploy-health.test.ts`

**What to build:**
- Extract `checkReceiver(baseUrl: string): Promise<boolean>` from `demo.ts` to `shared/health.ts`
- Update `demo.ts` to import from shared
- Add `waitForReceiver(url: string, timeoutMs: number): Promise<boolean>` — polls `checkReceiver` with retry (for deploy, Receiver may take 10-30s to cold start)

**Test strategy:**
- Mock `globalThis.fetch`
- Test: 200 → true
- Test: non-200 → false
- Test: network error → false
- Test: `waitForReceiver` retries on failure, succeeds when healthy
- Test: `waitForReceiver` times out → false
- Verify demo.ts still works with extracted function (existing demo tests must pass)

**Commit:** `refactor(cli): extract checkReceiver to shared health module`

---

## Task 5: Main deploy command (orchestrator)

**Files:**
- Create: `packages/cli/src/commands/deploy.ts`
- Test: `packages/cli/src/__tests__/deploy.test.ts`

**What to build:**
- `DeployOptions` interface: `{ platform?: "vercel" | "cloudflare"; yes?: boolean; noInteractive?: boolean }`
- `runDeploy(_argv: string[], options: DeployOptions): Promise<void>` — orchestrates Tasks 1-4:
  1. Resolve API key via `resolveApiKey` (same as demo)
  2. Platform selection: use `options.platform` or prompt (error if `noInteractive` without `--platform`)
  3. Detect platform CLI installed → error if not
  4. Check platform auth → error if not logged in
  5. Confirm deploy (unless `--yes`)
  6. Run platform deploy → capture URL
  7. Prompt AUTH_TOKEN from Console
  8. Preview .env changes → confirm → write
  9. Run readiness check on deployed URL
  10. Print completion: Console URL, next steps

**Test strategy (mock all submodules):**
- Mock: `credentials.resolveApiKey`, `platform.*`, `executor.runPlatformDeploy`, `env-writer.*`, `shared/health.*`
- Test: no API key → exit(1)
- Test: no platform in non-interactive → exit(1)
- Test: platform CLI missing → exit(1) with install instructions
- Test: platform auth failed → exit(1) with login instructions
- Test: deploy fails → exit(1)
- Test: user declines deploy → early return
- Test: user declines .env write → skip write, print manual instructions
- Test: readiness check fails → warning (not exit), print troubleshooting
- Test: happy path → all steps called in order, completion message printed

**Commit:** `feat(cli): add deploy command orchestrator`

---

## Task 6: CLI registration + README cleanup

**Files:**
- Modify: `packages/cli/src/cli.ts` — register `deploy` subcommand (lazy import, same pattern as `demo`)
- Modify: `README.md` — replace `init --upgrade` section with `deploy` command
- Test: `packages/cli/src/__tests__/cli.test.ts` — add deploy registration test if needed

**What to change in README:**
- Lines 41-55 ("Deploy to Vercel" section): keep the Deploy button and steps 1-4, replace step 5 (`init --upgrade`) with `npx 3amoncall deploy`
- Add non-interactive example: `npx 3amoncall deploy --platform vercel --yes`

**Commit:** `feat(cli): register deploy command and update README`

---

## Completion Criteria

### Implementation gate
- [ ] All 6 tasks implemented with passing tests
- [ ] `pnpm build` succeeds
- [ ] `pnpm test` — all tests pass (including existing demo tests)
- [ ] `pnpm typecheck` — no errors
- [ ] `pnpm lint` — no errors

### UX gate
- [ ] `npx 3amoncall deploy --help` shows correct options
- [ ] `npx 3amoncall deploy --platform vercel --yes` runs the full flow (requires real Vercel CLI — manual verification)
- [ ] README `--upgrade` references are gone
- [ ] Error messages include actionable fix instructions (install CLI, login, etc.)

### Prohibited states (cannot claim completion if any are true)
- `--upgrade` still referenced anywhere in the codebase
- `deploy.ts` has `console.log` instead of `process.stdout.write`
- Error paths exit without printing fix instructions
- `.env` writer overwrites file without user approval (unless `--yes`)
- `child_process` calls use `exec` (shell injection risk) instead of `execFile`/`spawn`
- Tests use real filesystem or real network calls without mocking
- Any TODO/FIXME comments remain
