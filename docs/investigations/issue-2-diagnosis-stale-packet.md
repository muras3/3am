# Issue 2: Vercel Auto-Diagnosis Misidentifies Root Cause (Redis vs. Payment Timeout)

**Status:** Investigation complete — awaiting implementation PR  
**Date:** 2026-04-12  
**Author:** Investigation via live Vercel receiver data + code cross-reference

---

## 1. Summary

During the Vercel walkthrough, auto-diagnosis for incident `inc_000001` concluded that Upstash Redis was the root cause of a payment timeout scenario. Cloudflare Workers correctly identified `e2e-mock-payment` as the root cause (8/8). Three hypotheses were formed. Live data and code analysis show that **Hypothesis B (single-shot freeze) is the most likely primary cause**. Hypothesis C (formation merge contamination) is a strong amplifying factor under the alternative scenario where diagnosis fired later against a mixed-evidence packet. Hypothesis A (stale generation snapshot) identifies a structural blindspot. The exact generation used at diagnosis time cannot be proven post-hoc due to missing schema fields, so B and C are assessed as "high probability" rather than "confirmed."

---

## 2. Background

### Walkthrough Sequence (Vercel)

| Time | Event |
|------|-------|
| `02:08:50` | First spans ingested: `GET /api/orders` returning HTTP 500 with `TypeError: Invalid URL` on `fetch POST` child spans — this is the Redis `Invalid URL` error from missing `.env.local` |
| `02:08:50` | Incident `inc_000001` created (generation=1); `scheduleDelayedDiagnosis` fires with `maxWaitMs=30000ms` |
| `02:08:51` | `exception` and `span_error` trigger signals recorded |
| `02:10:22` | `slow_span` and `http_504` signals appear — payment service timeout (30s) spans arrive |
| `02:11:25` | Packet window closes (final generation=6 after read-path materialization) |
| `02:13:11` | `diagnosedAt` recorded — diagnosis result stored |

### Observed Discrepancy

- **CF**: root cause = `e2e-mock-payment` timeout (correct)
- **Vercel**: root cause = `Upstash Redis literate-haddock-91733.upstash.io` connection timeout (incorrect)

### Known Facts at Start of Investigation

- `packet.generation = 6` confirmed
- `diagnosisResult` identified Redis as root cause
- Evidence endpoint showed: traces=20, logs=2, metrics=442

---

## 3. Hypotheses

### Hypothesis A: Diagnosis Ran Against a Stale (Low-Generation) Packet

**Claim:** `diagnosis-runner.ts` calls `storage.getIncident()` directly (line 26), which returns the stored packet without triggering `ensureIncidentMaterialized`. If the packet had not been rebuilt since generation=1 (the Redis TypeError batch), diagnosis would see only that initial evidence.

**Code evidence:**  
- `diagnosis-runner.ts` line 26: `const incident = await this.storage.getIncident(incidentId)` — no materialization call  
- `diagnosis-runner.ts` lines 37/44: `await diagnose(incident.packet, ...)` — passes stored packet directly  
- `materialization.ts` line 57: `await rebuildSnapshots(...)` is called **only** from `ensureIncidentMaterialized`, which is on the **read API path**, not the diagnosis path  
- `snapshot-builder.ts` line 209: `const generation = (incident.packet.generation ?? 1) + 1` — packet generation increments **only on updatePacket** from rebuildSnapshots, which requires a read-path trigger  

**Live data:**  
The packet at diagnosis time (`02:13:11`) shows `generation=6` and `window.end=02:11:25`. The scope shows `affectedDependencies: ['literate-haddock-91733.upstash.io']`. This means a READ API call DID materialize the packet at some point before diagnosis fired. However, this does not rule out a race condition where:
1. Incident created at generation=1 with Redis TypeError data only
2. `scheduleDelayedDiagnosis` fires at `02:08:50 + 30s = 02:09:20` (during the 30s payment hang)
3. Payment 504 traces arrive at `02:10:22` — AFTER diagnosis may have already started
4. Diagnosis could have used generation<4 packet

**Verdict:** **Partially valid.** There is no `packet_generation` field in `DiagnosisResult.metadata` (confirmed: `diagnosis-result.ts` metadata contains only `incident_id`, `packet_id`, `model`, `prompt_version`, `created_at`). It is therefore impossible to determine post-hoc which generation was used. The risk is real even if the current generation=6 state appears fresh.

---

### Hypothesis B: Single-Shot Freeze — Diagnosis Never Re-runs After First Result

**Claim:** `diagnosis-debouncer.ts` checks `incident.diagnosisResult` and skips re-runs entirely once a result exists. Any evidence arriving after the first diagnosis run is ignored.

**Code evidence:**  
- `diagnosis-debouncer.ts` line 106: `if (incident?.diagnosisResult) return; // Already diagnosed — skip.` (in `scheduleDelayedDiagnosis`)  
- `diagnosis-debouncer.ts` line 136: `if (incident?.diagnosisResult) return;` (in `checkGenerationThreshold`)  
- `diagnosis-debouncer.ts` line 199: `if (incident.diagnosisResult) return "skipped";` (in `runIfNeeded`)  
- `materialization.ts` line 61-72: `checkGenerationThreshold` is called after each `rebuildSnapshots`, but all three check paths above short-circuit once `diagnosisResult` is present

**Live data:**  
`diagnosedAt: 02:13:11` — this is 4+ minutes after `openedAt: 02:08:50`. The `maxWaitMs=30000ms` means diagnosis was scheduled to fire at approximately `02:09:20`. By `02:13:11`, all evidence (both TypeError and payment 504 traces) had already been ingested. However, the outcome depends on what was in the packet at `02:09:20` — the 30s payment spans were not yet ingested at that point.

**The critical race:**
- `t=02:08:50`: Incident created with TypeError/Redis data (gen=1), `scheduleDelayedDiagnosis` fires
- `t=02:09:20` (approx): Delayed diagnosis wakes up — at this moment, payment 504 spans have NOT yet arrived (they first appear at `02:10:22`). Diagnosis reads packet at this point.
- `t=02:10:22`: Payment timeout spans arrive — `touchIncidentActivity` marks incident stale
- `t=02:10:22+`: Read-path materialization rebuilds packet to include 504 traces — but `diagnosisResult` is now set (or being set), so `checkGenerationThreshold` skips
- `t=02:13:11`: `diagnosedAt` is stored — LLM took ~4 minutes (consistent with cold start + LLM latency on Vercel)

**The freeze means**: even after payment timeout traces arrive and are materialized into generation 3–6, no re-diagnosis is ever triggered.

**Verdict:** **Most likely primary cause** (code-backed, timing inferred). The single-shot freeze is by design but creates an unrecoverable miss when early-arriving noise evidence precedes the actual root cause evidence by more than `maxWaitMs`. The exact packet generation read at `02:09:20` cannot be proven, but the structural race is verified by code.

---

### Hypothesis C: Formation Merge — Redis TypeError and Payment Timeout in Same incidentId

**Claim:** The initial Redis `TypeError: Invalid URL` spans and the subsequent payment service timeout spans were merged into the same incident `inc_000001`, contaminating the evidence bundle used for diagnosis.

**Code evidence:**  
- `formation.ts` lines 123-181: `shouldAttachToIncident` — the second batch (payment spans) would attach to `inc_000001` if `signalTimeMs - openedAtMs <= FORMATION_WINDOW_MS` (5 minutes) AND the dependency or service matches.  
- The payment spans have `serviceName=e2e-order-app-vercel` — same as the Redis TypeError spans. So `scope.primaryService === key.primaryService` → `return true` (line 170).  
- `formation.ts` line 145: `FORMATION_WINDOW_MS = 5 * 60 * 1000` — payment spans at `02:10:22` are within 90 seconds of `openedAt=02:08:50`, so they attach.

**Live data from evidence endpoint:**  
All 10 `observed` traces in `surfaces.traces` are `GET /api/orders` returning 500 with `TypeError` on `fetch POST` child spans (`durationMs` 4491–4511ms, not 30000ms). The `representativeTraces` in the packet show BOTH the 30s 504 traces AND the short TypeError traces. The incident has **both** signal types merged.

**What the LLM saw:** The packet passed to `diagnose()` contained:
- `triggerSignals`: `exception` (first seen `02:08:51`, from TypeError batch) and `span_error` appearing before `slow_span`/`http_504`
- `scope.affectedDependencies`: `literate-haddock-91733.upstash.io` — Redis hostname is prominent in scope
- `evidence.representativeTraces`: mix of 30s spans (504) and 0ms/short spans (TypeError)
- The first trigger signal by timestamp is `span_error` at `02:08:50` — the Redis TypeError event

The LLM correctly analyzed the most prominent signal in the packet. The Redis hostname appears explicitly in `affectedDependencies` while the payment service (`e2e-mock-payment`) does NOT appear — because `e2e-mock-payment` is an internal service, and `peerService` for the payment timeout spans points to an empty URL (`http.url: ""`).

**Verdict:** **Strong amplifying factor under the later-packet hypothesis.** The merge is correct per ADR 0017, but if the LLM saw a packet containing only the Redis TypeError evidence (Hypothesis B timeline), C was not operative for that specific run. C becomes causative only if diagnosis fired after payment spans arrived. Since `packet_generation` is not persisted in `DiagnosisResult.metadata`, this cannot be proven. Under either timeline, C identifies a structural evidence contamination problem worth fixing independently.

**Correction on `http.url` attribution (Codex review finding):** The original report incorrectly attributed dependency invisibility to `http.url: ""`. Code inspection shows that `affectedDependencies` is built from `peer.service` / `server.address` span attributes only — not from `http.url` (see `anomaly-detector.ts:253`, `snapshot-builder.ts:124-131`, `packetizer.ts:345-352`). The correct explanation is: the payment spans lack `peer.service` or `server.address` attributes, not that `http.url` is empty. Fix 5.4 should target span attribute extraction at ingest time, not `formation.ts`.

---

## 4. Root Cause(s)

The misdiagnosis is a compound failure with one proven structural defect and two probable causal paths that cannot be simultaneously confirmed without `packet_generation` evidence:

**Primary (B — most probable):** The single-shot diagnosis freeze fires at `~02:09:20` when only the Redis TypeError evidence has been ingested. The 30s payment timeout spans arrive 62 seconds later at `02:10:22`. The freeze at all three debouncer checkpoints (`scheduleDelayedDiagnosis`, `checkGenerationThreshold`, `runIfNeeded`) prevents re-diagnosis from ever running.

**Amplifying (C — operative if diagnosis fired after 02:10:22):** If the actual LLM call fired later (e.g., due to Vercel cold start or queue retry), the packet would have contained both Redis TypeError evidence AND payment timeout spans, with `affectedDependencies` listing only the Redis hostname. The payment service is absent from `affectedDependencies` because its spans lack `peer.service` / `server.address` attributes. Under this scenario, C misdirects the LLM even with complete evidence. B and C cannot both be the proximate cause for the same diagnosis run — the timeline difference determines which applies.

**Structural blindspot (A):** No `packet_generation` is stored in `DiagnosisResult.metadata`, making it impossible to distinguish B from C after the fact, or to prove stale-packet diagnosis at all. This is an observability gap independent of which causal path applies.

---

## 5. Proposed Fix

### 5.1 Add `packet_generation` (and `diagnosis_started_at`) to `DiagnosisResult.metadata` (Schema)

**File:** `packages/core/src/schemas/diagnosis-result.ts`  
**Change:** Add `packet_generation: z.number().int().nonnegative().optional()` to `metadata` strictObject. Use `optional()` not required, to avoid breaking existing stored records.

**Backward-compatibility constraint (Codex finding):** `DiagnosisResultSchema` uses `z.strictObject()` and is parsed at every storage read (Postgres line 212, D1 line 159) and at `POST /api/diagnosis/:id` (api.ts line 623). Adding a **required** field would break all pre-existing stored diagnosis results. The field must be `optional()` and the implementation PR must include a migration plan or a schema compatibility test.

**Additional field:** Consider also adding `diagnosis_started_at` (ISO string) to distinguish when the LLM call began from when the result was persisted (`created_at` is set at result parse time, not at LLM call start).

**Downstream impact:** `packages/diagnosis/src/parse-result.ts` line 124 builds the metadata — it must read `packet.generation` and set `packet_generation`.

### 5.2 Pre-Diagnosis Materialization + Re-Fetch in `diagnosis-runner.ts`

**File:** `apps/receiver/src/runtime/diagnosis-runner.ts`  
**Change (two-part):**
1. Call `ensureIncidentMaterialized(incidentId, storage, telemetryStore)` before reading the incident for diagnosis.
2. After `ensureIncidentMaterialized` returns, call `storage.getIncident(incidentId)` **again** to get the freshly materialized packet. The current code reads `incident` once (line 26) and uses that same object for `diagnose(incident.packet, ...)`. Without re-fetching, materialization has no effect.

**Limitation (Codex finding):** `ensureIncidentMaterialized` is best-effort — it returns `false` without rebuilding if another reader holds the materialization lease (`materialization.ts:50-55`). A re-fetch after the call will still serve the latest DB state even if the rebuild was skipped by the lease check. This is acceptable — it reduces the stale window but does not eliminate it.

**Risk:** Adds one extra DB round-trip in the diagnosis hot path. On Vercel, this runs inside `waitUntil` so it does not block the HTTP response.

### 5.3 Unified Re-Diagnosis Gate (All Three Freeze Checkpoints)

**File:** `apps/receiver/src/runtime/diagnosis-debouncer.ts`  
**Critical scope correction (Codex finding):** The freeze check exists in **three independent locations**: `scheduleDelayedDiagnosis` (line 106), `checkGenerationThreshold` (line 136), and `runIfNeeded` (line 199). The original proposal only targeted `checkGenerationThreshold`. Fixing one location while leaving the other two unchanged means `runIfNeeded` will still return `"skipped"` immediately on any re-diagnosis attempt.

**Correct approach:** Extract a shared predicate function `shouldAllowRediagnosis(incident, currentGeneration)` and call it at all three freeze checkpoints. The predicate checks: `incident.diagnosisResult === undefined OR (packet_generation gap > threshold AND rediagnosis_count < 1)`.

**Rate-limiting constraint:** Re-diagnosis should be allowed at most once per incident lifetime. Add `rediagnosis_count: number` to the incidents table (default 0). The fix must include a DB migration.

### 5.4 `peer.service` / `server.address` Backfill for Internal Services

**File:** Span extraction at ingest time — NOT `formation.ts` or `evidence-extractor.ts`  
**Correction (Codex finding):** The original proposal incorrectly attributed the missing dependency to `http.url: ""`. The actual code path builds `affectedDependencies` from `peer.service` or `server.address` attributes only (see `anomaly-detector.ts:253`, `snapshot-builder.ts:124-131`, `packetizer.ts:345-352`). The payment service spans lack these attributes entirely — the URL being empty is a symptom, not the cause.

**Correct fix:** At OTLP span ingest time (in the span decoder), when a span has a `fetch` span name with a non-empty `http.method` but missing `peer.service` / `server.address`, attempt to extract a hostname from `http.url` or `url.full`. If `http.url` is empty/invalid, fall back to a synthetic label based on the route context. This is still heuristic — flag as lower priority and separate PR.

### Test Strategy

- **`diagnosis-runner.test.ts`**: Verify that `ensureIncidentMaterialized` is called AND that `storage.getIncident` is called **after** it returns. Assert that the re-fetched (materialized) packet is passed to `diagnose`.
- **`diagnosis-debouncer.test.ts`**: Add tests for all three freeze checkpoints: given an incident with `diagnosisResult` where `packet_generation=1` and current `packet.generation=5`, assert that `scheduleDelayedDiagnosis`, `checkGenerationThreshold`, AND `runIfNeeded` all respect the re-diagnosis gate.
- **New integration test** (`apps/receiver/src/__tests__/diagnosis-race.test.ts`): Simulate the walkthrough sequence — ingest TypeError spans, wait `maxWaitMs`, then ingest payment spans with no intermediate reads. Assert that re-diagnosis fires and that `diagnosisResult.metadata.packet_generation` reflects the payment-era generation.
- **Compatibility test**: After adding `packet_generation` as optional, assert that existing `DiagnosisResult` fixtures without the field still parse successfully.
- **Lease contention test**: Simulate materialization lease held by another reader at the time `diagnosis-runner.ts` calls `ensureIncidentMaterialized`. Assert diagnosis still proceeds with the most recent DB state.

---

## 6. Out of Scope for This PR

- Implementing any of the fixes above (code-only PR follows separately)
- Investigating why CF correctly identified the root cause (CF uses Queue-based dispatch with explicit delay, not `waitUntil + sleep` — the payment spans arrive before the queue consumer processes the message)
- Baseline evidence support (currently `state.baseline = "unavailable"`) — separate issue

---

## 7. Open Questions

1. **What is `maxWaitMs` set to on the live Vercel deployment?** Default is 30000ms. If it was overridden to a longer value, the payment spans would have been present at diagnosis time and Hypothesis B is less certain.

2. **Does the Vercel `waitUntil` guarantee actually hold?** On Vercel Serverless, `waitUntil` keeps the function alive after the response, but there is a maximum execution time limit (default 10s for Hobby, 300s for Pro). If the function times out, the delayed diagnosis may never fire, and `diagnosedAt` may reflect a later retry or a manual rerun via `POST /api/incidents/:id/diagnose`.

3. **What `DIAGNOSIS_GENERATION_THRESHOLD` (default=15) is used on Vercel?** At generation=6, this threshold was not reached. The diagnosis was triggered by `maxWaitMs` (30s delay), not by generation threshold. If threshold had been lower (e.g., 5), diagnosis might have fired at a later generation with better evidence — but only if a read-path call had already triggered materialization first.

4. **Are `peer.service` / `server.address` attributes absent from payment spans by design or by instrumentation gap?** All `fetch POST` spans in the TypeError traces lack `peer.service` / `server.address`. This may reflect Next.js OTel auto-instrumentation behavior when the downstream URL is unresolvable (TypeError thrown before the HTTP call is made). Confirming this is a prerequisite for designing fix 5.4.

5. **Could a lower `DIAGNOSIS_GENERATION_THRESHOLD` (e.g., 5–8) alone fix the misdiagnosis?** Only partially. This would delay diagnosis to a later generation, but only if a read-path call has already triggered materialization AND no `diagnosisResult` exists yet. Without unifying the freeze checkpoints (fix 5.3), lowering the threshold still does not allow re-diagnosis once a result is stored.

6. **Does the no-read path leave re-diagnosis permanently blocked?** After diagnosis runs (even with a wrong result), subsequent ingestion only calls `touchIncidentActivity`. Snapshots are rebuilt only on read-path calls to `/api/incidents/:id`, `/api/incidents/:id/packet`, or `/api/packets/:packetId`. If no read occurs after new evidence arrives, `packet.generation` never advances, `checkGenerationThreshold` never fires, and the wrong result persists indefinitely. Fix 5.3's generation-gap approach requires at least one read to occur. An alternative (not yet designed) would be to trigger re-diagnosis from the ingest path after significant new evidence arrives.

7. **Should `diagnosis_started_at` be tracked separately from `created_at`?** Currently `metadata.created_at` is set at result parse time (`parse-result.ts:124`), not when the LLM call begins. A `diagnosis_started_at` field would allow measuring LLM latency and distinguishing "diagnosis fired early but LLM was slow" from "diagnosis fired late." This would help prove or disprove the B timeline in future incidents.

---

## 8. Codex Review (gpt-5.4)

**Session:** `019d7f9b-8384-7901-91a6-831adaca86b7`  
**Date:** 2026-04-12  
**Model:** gpt-5.4

### Critical Findings (reflected in this document)

**[C1] Fix 5.3 scope was too narrow:** The original proposal targeted only `checkGenerationThreshold`. Codex identified that the `diagnosisResult` freeze check exists at three independent locations: `scheduleDelayedDiagnosis` (line 106), `checkGenerationThreshold` (line 136), and `runIfNeeded` (line 199). Fixing one while leaving the others means `runIfNeeded` still short-circuits. Section 5.3 updated to require a shared predicate function covering all three checkpoints.

**[C2] Fix 5.2 requires re-fetch after materialization:** The original proposal called `ensureIncidentMaterialized` but did not account for the fact that `DiagnosisRunner.run()` already holds an `incident` reference from `getIncident()` at line 26. Without re-fetching after materialization, the stale packet is still used. Section 5.2 updated to require an explicit re-fetch. Also clarified that `ensureIncidentMaterialized` is best-effort (returns `false` on lease contention) and does not guarantee freshness.

**[C3] B and C cannot both be "confirmed" simultaneously:** Under Hypothesis B's timeline (diagnosis at `02:09:20`), payment spans had not arrived yet, so C's mixed-bundle contamination was not operative for that specific run. Under a later-fire timeline, C applies. Since `packet_generation` is missing, neither can be proven. Updated summary and verdicts to use "most likely" / "amplifying factor" rather than "confirmed."

### Medium Findings (reflected in this document)

**[M1] `http.url` attribution was incorrect:** The report incorrectly tied dependency invisibility to `http.url: ""`. The actual code builds `affectedDependencies` from `peer.service` / `server.address` only (verified at `anomaly-detector.ts:253`, `snapshot-builder.ts:124-131`, `packetizer.ts:345-352`). Hypothesis C and Fix 5.4 updated to use correct attribute names. Fix 5.4 target file corrected from `formation.ts` to span extraction at ingest time.

**[M2] `packet_generation` must be `optional()` not required:** `DiagnosisResultSchema` uses `z.strictObject()` and is parsed on every DB read (Postgres line 212, D1 line 159) and on `POST /api/diagnosis/:id` (api.ts line 623). A required field addition would break all existing stored diagnosis records. Fix 5.1 updated to use `z.optional()` with a backward-compatibility note.

**[M3] Generation gap is a weak re-diagnosis trigger:** `packet.generation` increments on every `rebuildSnapshots` call (triggered only by reads), not per unit of meaningful new evidence. A gap of 3 may miss a single-rebuild evidence arrival, or fire spuriously if reads are frequent. Updated Fix 5.3 to note this limitation. Open Question 6 added to track the no-read path gap.

### Remaining Open Points (not yet designed)

- How to trigger re-diagnosis without requiring a read-path call (ingest-path trigger design)
- `diagnosis_started_at` tracking to distinguish early-fire from slow-LLM
- Materialization lease contention handling in the diagnosis path
