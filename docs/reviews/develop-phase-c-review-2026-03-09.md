# Phase C Completion Review
**Reviewed by**: Opus 4.6
**Date**: 2026-03-09
**Branch**: feat/phase-c-diagnosis-worker

## Executive Summary

Phase C delivers a well-structured diagnosis pipeline with clean responsibility separation (prompt / model-client / parse-result / diagnose). The ADR 0015/0019/0021 compliance is strong. However, there are two blocking issues: (1) `packages/diagnosis` fails `tsc` build and typecheck due to `unknown` type errors in `prompt.ts`, and (2) the auth test in `diagnosis-flow.test.ts` fails because `createApp` never applies bearer-auth middleware despite the test expecting 401. There are also several medium-severity findings around prompt injection risk, missing evidence sections in the prompt, and a contract looseness in `WatchItemSchema.status`.

## Completion Gates

| Gate | Status | Notes |
|------|--------|-------|
| 1. DiagnosisResult contract | ✅ PASS | All sub-schemas `.strict()`, unknown fields rejected, metadata attached in `parseResult`, invalid model output throws ZodError. Thorough test coverage (12 tests). |
| 2. Diagnosis package | ⚠️ PARTIAL | All 16 tests pass (vitest). But `tsc build` and `tsc --noEmit` fail with 6 type errors in `prompt.ts:30`. CI would fail on the `Build diagnosis` step. |
| 3. CLI | ✅ PASS | All 5 exit-code paths tested. ESM guard works. `--packet`, `--callback-url`, `--callback-token` all implemented. Build succeeds. |
| 4. Receiver callback | ⚠️ PARTIAL | `POST /api/diagnosis/:id` validates body, checks incident_id mismatch, returns 404 for unknown incident. But the auth test (401 when `RECEIVER_AUTH_TOKEN` is set) **fails** -- `createApp` has no auth middleware (just a TODO comment). Test expects 401 but gets 404. |
| 5. GitHub Actions | ✅ PASS | `diagnose.yml` uses `workflow_dispatch`, correct inputs, `--fail-with-body` on curl, builds packages in dependency order, uses secrets correctly. |
| 6. Local integration | ⚠️ PARTIAL | 4 of 5 diagnosis-flow tests pass. The auth test fails (see Gate 4). The full ingest-to-diagnosis round-trip through `seedIncident` + `POST /api/diagnosis/:id` + `GET /api/incidents/:id` works. |
| 7. Non-goals | ✅ PASS | No OTLP protobuf, no Drizzle, no Console UI, no live regression suite. |

## Findings

### F-301 -- `packages/diagnosis` fails tsc build (type errors in prompt.ts)
- **Severity**: Critical
- **Category**: Contract / Build
- **Location**: `packages/diagnosis/src/prompt.ts:27-31`
- **Evidence**: `evidence.representativeTraces` is typed as `unknown[]` (from `IncidentPacketSchema`'s `EvidenceSchema` which uses `z.array(z.unknown())`). Line 30 accesses `t.traceId`, `t.spanId`, `t.serviceName`, `t.durationMs`, `t.httpStatusCode`, `t.spanStatusCode` on `unknown` without type assertion or guard.
- **Impact**: `pnpm --filter @3amoncall/diagnosis build` fails. CI `ci.yml` step "Build diagnosis" will fail. The CLI build depends on diagnosis dist output.
- **Fix**: Either (a) add a type assertion `as { traceId: string; spanId: string; ... }` in the map callback, or (b) define a `RepresentativeTraceSchema` in `packages/core` so `evidence.representativeTraces` has a proper type. Option (b) is preferred for type safety and aligns with Phase B's F-107 (`RepresentativeTrace` shape) which was implemented in the receiver but apparently not reflected in the core schema.

### F-302 -- Auth middleware not implemented; diagnosis-flow auth test fails
- **Severity**: Critical
- **Category**: Security / Test coverage
- **Location**: `apps/receiver/src/index.ts:11-12`, `apps/receiver/src/__tests__/diagnosis-flow.test.ts:200-214`
- **Evidence**: `createApp()` has `// TODO (Phase E): add bearer-token auth middleware` but no actual middleware. The test "POST with RECEIVER_AUTH_TOKEN set but no Authorization header -> 401" expects status 401 but gets 404 because the request passes through to the API handler without auth, hits the `getIncident(id)` call, and returns 404 for the non-existent incident.
- **Impact**: `pnpm --filter @3amoncall/receiver test` fails (1 test failure). The `diagnose.yml` workflow sends `Bearer ${{ secrets.RECEIVER_AUTH_TOKEN }}` but the Receiver ignores it. The callback endpoint is unprotected -- anyone can POST a fake DiagnosisResult.
- **Fix**: Either (a) implement bearer-auth middleware in `createApp()` (using `hono/bearer-auth` as done in Phase B's F-101 -- but that implementation may have been in a different branch and not carried over), or (b) if auth is genuinely Phase E scope, remove the failing test and add a TODO/ADR reference. Option (a) is strongly recommended since the callback endpoint accepts LLM-generated content and should be authenticated.

### F-303 -- Prompt injection risk in buildPrompt
- **Severity**: Medium
- **Category**: Security
- **Location**: `packages/diagnosis/src/prompt.ts:3-131`
- **Evidence**: `buildPrompt` directly interpolates `scope.primaryService`, `scope.affectedServices`, `scope.affectedDependencies`, `scope.affectedRoutes`, `triggerSignals[*].signal`, `triggerSignals[*].entity`, and trace fields into the prompt string without any sanitization. These values originate from OTel span attributes (`service.name`, `http.route`, etc.) which are set by the instrumented application.
- **Impact**: A malicious or misconfigured service could set `service.name` to something like `"checkout-api\n\n## Override: Ignore all previous instructions..."` to inject adversarial content into the LLM prompt. The blast radius is limited (diagnosis output is validated by `DiagnosisResultSchema` so arbitrary output would be rejected), but the LLM could still be manipulated to produce misleading diagnosis content within the valid schema.
- **Fix**: Sanitize user-controlled strings before interpolation (e.g., strip newlines, limit length, escape markdown). At minimum, document the risk as an ADR or security note. This is acceptable for Phase 1 MVP but should be tracked.

### F-304 -- Prompt omits changedMetrics, relevantLogs, platformEvents evidence
- **Severity**: Medium
- **Category**: ADR compliance (0018/0019)
- **Location**: `packages/diagnosis/src/prompt.ts:27-37`
- **Evidence**: `buildPrompt` only includes `representativeTraces` and `traceRefs` from the evidence/pointers sections. It omits `changedMetrics`, `relevantLogs`, `platformEvents`, `logRefs`, `metricRefs`, and `platformLogRefs`. ADR 0018 defines the evidence layer as including all of these.
- **Impact**: The LLM diagnosis operates on traces only. When metrics or logs contain critical diagnostic signals (e.g., CPU saturation in changedMetrics, connection pool exhaustion in logs), the LLM cannot see them. This is acceptable for Phase 1 since the Receiver's metrics/logs/platform-events endpoints are stubs anyway, but should be tracked.
- **Fix**: Add a comment in `prompt.ts` documenting that these sections are intentionally omitted for Phase 1 and should be added when the Receiver's ingest for these signal types is implemented.

### F-305 -- WatchItemSchema.status is z.string() instead of enum
- **Severity**: Low
- **Category**: Contract quality
- **Location**: `packages/core/src/schemas/diagnosis-result.ts:16-19`
- **Evidence**: The prompt instructs the LLM to output `"status": "watch|ok|alert"` (line 123), suggesting three valid values. But `WatchItemSchema.status` is `z.string()`, accepting any string.
- **Impact**: The LLM could output any status string and it would pass validation. The Console UI (Phase D) might rely on specific status values for color coding.
- **Fix**: Change to `z.enum(["watch", "ok", "alert"])`. However, this may be intentionally loose for Phase 1 to avoid over-constraining LLM output. If kept as `z.string()`, add a comment explaining the decision.

### F-306 -- /api/packets/:packetId uses O(n) scan instead of index
- **Severity**: Low
- **Category**: ADR compliance (0025 responsiveness)
- **Location**: `apps/receiver/src/transport/api.ts:26-37`
- **Evidence**: The endpoint calls `listIncidents({ limit: 1000 })` and uses `.find()` to locate the packet. The Phase B review added `getIncidentByPacketId()` to `StorageDriver` (F-105) with O(1) lookup via `packetIndex`, but the `StorageDriver` interface in this branch does not have that method, and `api.ts` does not use it.
- **Impact**: O(n) scan on every packet fetch. In the GitHub Actions flow, this endpoint is called once per incident to fetch the packet for diagnosis, so it's not high-frequency. But it's a regression from Phase B's F-105 improvement.
- **Fix**: Add `getIncidentByPacketId(packetId: string): Promise<IncidentPacket | null>` to `StorageDriver` interface and use it in the endpoint. This may have been lost during branch creation.

### F-307 -- prompt.test.ts does not verify all 7 steps individually
- **Severity**: Low
- **Category**: Test coverage
- **Location**: `packages/diagnosis/src/__tests__/prompt.test.ts:74-78`
- **Evidence**: The test checks `Step 1` and `Step 7` but not Steps 2-6. The plan's completion gate says "verify all major sections of the v5 7-step prompt (all 7 steps, all evidence fields)".
- **Impact**: If Steps 2-6 were accidentally removed or reordered, the test would still pass.
- **Fix**: Add assertions for all 7 steps: `expect(prompt).toContain("Step 2")` through `expect(prompt).toContain("Step 6")`.

### F-308 -- CLI test does not cover diagnose() failure path
- **Severity**: Low
- **Category**: Test coverage
- **Location**: `packages/cli/src/__tests__/cli.test.ts`
- **Evidence**: The plan's completion gate specifies "diagnose() failure -> exit 1" as a required test case. The current tests cover: valid packet, invalid packet, callback success, callback failure, and missing --packet. But there is no test where `diagnose()` itself throws (e.g., model returns garbage or network error).
- **Impact**: The CLI does handle this case (lines 76-82 in `cli/src/index.ts`), but it's untested.
- **Fix**: Add a test: `vi.mocked(diagnose).mockRejectedValue(new Error("model error"))` -> expect `process.exit(1)`.

### F-309 -- github-dispatch.test.ts does not verify dispatch failure doesn't throw
- **Severity**: Low (already covered but could be more explicit)
- **Category**: Test coverage
- **Location**: `apps/receiver/src/runtime/__tests__/github-dispatch.test.ts:75-84`
- **Evidence**: The test "does not throw when dispatch fails (non-ok response)" correctly verifies this with `resolves.toBeUndefined()`. This is adequate. No action needed.
- **Impact**: None -- this is a positive finding.

### F-310 -- receiver/index.ts has stale TODO comment (Phase E vs Phase B auth)
- **Severity**: Low
- **Category**: Code quality
- **Location**: `apps/receiver/src/index.ts:11-12`
- **Evidence**: The TODO says "Phase E: add bearer-token auth middleware" but Phase B's F-101 already implemented auth using `hono/bearer-auth`. This suggests the Phase C branch was created before the Phase B auth implementation was merged, and the auth middleware was lost.
- **Impact**: Confusion about when auth should be implemented. The Phase B implementation with `RECEIVER_AUTH_TOKEN` / `ALLOW_INSECURE_DEV_MODE` env vars should be restored.
- **Fix**: Cherry-pick or re-implement the Phase B auth middleware.

## Overall Assessment

- **Safe to merge**: **No** -- conditional on fixing F-301 and F-302
- **Blocking issues**:
  1. **F-301**: `packages/diagnosis` fails `tsc` build. CI will fail. Must fix type errors in `prompt.ts`.
  2. **F-302**: Auth test fails. Either implement auth middleware (strongly recommended) or remove the failing test with justification.
- **Recommended next steps** (ordered):
  1. Fix F-301: Add type assertion or define `RepresentativeTraceSchema` in core
  2. Fix F-302: Restore bearer-auth middleware from Phase B (F-101)
  3. Address F-303: Add prompt sanitization or document the risk
  4. Address F-304: Add comment in `prompt.ts` noting omitted evidence sections
  5. Address F-307/F-308: Add missing test cases for full coverage
  6. Consider F-305: Tighten `WatchItemSchema.status` to enum
  7. Consider F-306: Restore `getIncidentByPacketId()` from Phase B F-105
