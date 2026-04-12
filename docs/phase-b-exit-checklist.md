# Phase B Exit Checklist

**Date**: 2026-03-08
**Branch**: `fix/phase-b-codex-review-findings` (PR #41, base: `develop`)
**Reviewer**: Codex gpt-5.4 × 2 rounds (review + follow-up)

---

## Test Suite

| Check | Result | Detail |
|-------|--------|--------|
| `@3am/core` test | ✅ PASS | 36/36 tests |
| `@3am/core` typecheck | ✅ PASS | tsc --noEmit clean |
| `@3am/receiver` test | ✅ PASS | 72/72 tests |
| `@3am/receiver` typecheck | ✅ PASS | tsc --noEmit clean |
| `@3am/receiver` lint | ⚠️ SKIP | eslint binary not installed in monorepo (no `eslint` devDep at root) |

---

## Phase B Core Responsibilities

### Packet Generation

| Item | Result | Evidence |
|------|--------|---------|
| Error span (HTTP 5xx) triggers incident | ✅ YES | `integration.test.ts` + local run |
| Error span (429) triggers incident | ✅ YES | `anomaly-detector.test.ts` |
| Slow span (>5000ms) triggers incident | ✅ YES | `anomaly-detector.test.ts` |
| Exception event triggers incident | ✅ YES | `anomaly-detector.test.ts` |
| Normal span does NOT trigger incident | ✅ YES | `integration.test.ts` |
| `peer.service` → `affectedDependencies` | ✅ YES | `packetizer.test.ts` |
| `schemaVersion: "incident-packet/v1alpha1"` | ✅ YES | local: `GET /api/packets/:id` |
| `IncidentPacketSchema` validates packet | ✅ YES | strict mode; unknown fields → ZodError |

### Packet Persistence

| Item | Result | Evidence |
|------|--------|---------|
| `createIncident()` stores packet | ✅ YES | `memory.test.ts` |
| `getIncidentByPacketId()` O(1) lookup | ✅ YES | `packetIndex` Map; `memory.test.ts` |
| Second signal within 5min attaches to existing incident (no new ThinEvent) | ✅ YES | `integration.test.ts` |
| Second signal outside 5min creates new incident | ✅ YES | `formation.test.ts` |

### Read API

| Item | Result | Evidence |
|------|--------|---------|
| `GET /api/incidents` returns list | ✅ YES | local: 200, items array |
| `GET /api/incidents` limit clamp (1–100, NaN→20) | ✅ YES | `integration.test.ts` |
| `GET /api/incidents/:id` returns incident | ✅ YES | local: correct incidentId |
| `GET /api/packets/:packetId` O(1) lookup | ✅ YES | local: correct schemaVersion |
| `POST /api/diagnosis/:id` attaches result | ✅ YES | local: status ok |
| `GET /api/incidents/:id` includes diagnosisResult after POST | ✅ YES | local: `what_happened`, `immediate_action` present |

### Auth (ADR 0011)

| Item | Result | Evidence |
|------|--------|---------|
| No token + no opt-in → startup throws | ✅ YES | `integration.test.ts` (F-201 fail-closed) |
| `ALLOW_INSECURE_DEV_MODE=true` → auth disabled (dev only) | ✅ YES | `integration.test.ts` + local run |
| Valid Bearer token → 200 | ✅ YES | `integration.test.ts` |
| Wrong token → 401 | ✅ YES | `integration.test.ts` |
| Missing Authorization header → 401 | ✅ YES | `integration.test.ts` |

### Body Limit (ADR 0022)

| Item | Result | Evidence |
|------|--------|---------|
| Payload ≤ 1MB → accepted | ✅ YES | normal test traffic passes |
| Payload > 1MB → 413 | ✅ YES | `integration.test.ts` (F-203) |

### Schema (ADR 0018)

| Item | Result | Evidence |
|------|--------|---------|
| `PointersSchema` refs typed as `z.string()` | ✅ YES | `incident-packet.test.ts` (F-204) |
| `representativeTraces` typed via `RepresentativeTraceSchema` | ✅ YES | `incident-packet.test.ts` (F-204) |
| All schemas `.strict()` — unknown fields rejected | ✅ YES | `incident-packet.test.ts` |
| LLM output fields (immediateAction etc.) cause ZodError | ✅ YES | `incident-packet.test.ts` |

---

## Local Happy Path (2026-03-08)

Run against: `ALLOW_INSECURE_DEV_MODE=true node apps/receiver/dist/server.js`

```
POST /v1/traces        → 200 { status: "ok", incidentId, packetId }
GET  /api/incidents    → 200 { items: [{ incidentId, status: "open", packet: { schemaVersion: "incident-packet/v1alpha1", ... } }] }
GET  /api/incidents/:id → 200 { incidentId, status, packet }
GET  /api/packets/:id  → 200 { schemaVersion: "incident-packet/v1alpha1", scope.affectedDependencies: ["stripe"], ... }
POST /api/diagnosis/:id → 200 { status: "ok" }
GET  /api/incidents/:id → 200 { ..., diagnosisResult: { summary.what_happened, recommendation.immediate_action, ... } }
```

All 6 steps ✅ passed end-to-end on local MemoryAdapter.

---

## Known Gaps (explicitly deferred)

| Gap | Phase | Reason |
|-----|-------|--------|
| Protobuf ingest (OTLP binary) | Phase E | ADR 0022 protobuf-first is Phase E scope; 501 + TODO comment in place |
| `changedMetrics`, `relevantLogs`, `platformEvents` typed (currently `z.unknown[]`) | Phase C | typed when metric/log ingest implemented |
| CloudflareAdapter / VercelAdapter (persistent storage) | Phase E | MemoryAdapter sufficient for Phase B |
| GitHub Actions dispatch after `incident.created` | Phase C | TODO comment in `ingest.ts`; ADR 0021 |
| ESLint binary not in monorepo devDeps | Infra | script exists but dep missing; not a Phase B blocker |

---

## Verdict

**Phase B: COMPLETE** ✅

All Phase B responsibilities (packet generation, persistence, read API, auth, body limit, schema contracts) are implemented, tested (72 receiver + 36 core), typechecked, and locally verified end-to-end. Deferred items are explicitly scoped to Phase C/E with TODO markers.
