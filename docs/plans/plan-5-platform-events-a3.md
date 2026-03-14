# Plan 5: Platform Events Integration (A-3)

## Series Context

```
Wave 1:  ✅ Plan 1 (A-1+B-3)
Wave 2:  ✅ Plan 2 (A-2)  |  ✅ Plan 3 (B-1)  |  ✅ Plan 4 (B-2)
Wave 3:  ▶ Plan 5 (A-3)  |  Plan 6 (B-4)  |  Plan 7 (B-5)  |  Plan 8 (B-6)  ← 並列可
```

Depends on: Plan 1 (raw state + rebuild)、Plan 2 (formation key — platform events の incident attach に使用)

## Execution Model

1. `develop` から `codex/packet-remediation-a3` ブランチを切る
2. **New ADR: Platform Event Contract → ユーザー承認**
3. **TeamCreate** (Sonnet) で実装
4. `/simplify` 実行
5. PR → Opus レビュー → 修正 (最大 3 ラウンド)
6. Observable completion criteria 検証

## Why

`/v1/platform-events` が validate 後に `status: ok` を返すだけ。deploy/config/provider 起因の障害文脈が packet に反映されない。

## Current State

- `/v1/platform-events` (ingest.ts): body.events の存在チェックのみ → `{ status: "ok" }`
- packet の `evidence.platformEvents` は `unknown[]` で常に空
- platform event の schema 定義なし

## What to Change

### 1. New ADR: Platform Event Contract
- event types: `deploy`, `config_change`, `provider_incident`, `scaling_event`
- required fields: `eventType`, `timestamp`, `environment`, `description`
- optional fields: `service`, `deploymentId`, `releaseVersion`, `provider`, `eventId`, `details`
- incident attach policy:
  - environment 一致は必須
  - service 指定あり: `scope.affectedServices` に service を含む incident のみ候補
  - service 指定なし: environment 一致 incident を候補
  - time proximity: incident `window.start <= event.timestamp <= window.end`
  - cardinality: 複数 attach は行わず、候補が複数ある場合は `abs(window.detect - event.timestamp)` 最小の incident 1件に attach
  - tie-break: `openedAt` が新しい incident を優先、それでも同値なら `incidentId` lex
- packet 反映先:
  - `evidence.platformEvents`: typed object 本体
  - `pointers.platformLogRefs`: platform event 再取得用の最小参照キー
    - `eventId` があればそれを使う
    - なければ `${timestamp}:${eventType}:${service ?? provider ?? "global"}` を deterministic ref として生成する

### 2. Core schema 変更 (`packages/core/src/schemas/incident-packet.ts`)
- `PlatformEventSchema` を typed Zod schema として定義
- `evidence.platformEvents` を `PlatformEventSchema[]` に変更

### 3. Storage 変更
- raw state に platform events を追加 (Plan 1 で placeholder 済みなら活性化)
- `appendPlatformEvents(incidentId, events)` メソッド追加
- `rebuildPacket()` が `rawState.platformEvents` から
  - `evidence.platformEvents`
  - `pointers.platformLogRefs`
  を導出するよう変更
- ingest path から packet へ直接 append しない

### 4. Ingest 変更 (`apps/receiver/src/transport/ingest.ts`)
- `/v1/platform-events` を実装:
  1. 入力 validate (PlatformEventSchema)
  2. open incidents を scan、attach 条件評価
  3. matching incident の raw state に追加
  4. packet rebuild trigger

### 5. テスト
- platform event attach/non-match の unit test
- rebuild determinism test: 同一 rawState から同一 packet が出る
- integration test: trace → incident → platform event → packet に反映
- integration test: 候補 incident が複数ある時、最良の 1 件にのみ attach

## Sonnet 並列化

- Agent A: New ADR
- Agent B: Core schema (PlatformEventSchema)
- Agent C: Storage interface + adapters
- Agent D: Ingest 統合 + rebuild 連携
- Agent E: テスト

## Observable Completion Criteria

### OC-1: Platform event attach 観測
- trace → incident-1 (service-A, env=production)
- `POST /v1/platform-events` with deploy event (env=production, service=service-A)
- `GET /api/incidents/incident-1` → `packet.evidence.platformEvents` に deploy event 存在
- `packet.pointers.platformLogRefs` に deterministic ref が 1 件入る

### OC-2: Non-matching 観測
- 別 environment の platform event → attach されない
- service 不一致の platform event → attach されない

### OC-3: Typed contract 観測
- `platformEvents` が typed object 配列 (not `unknown[]`)
- `PlatformEventSchema` を通らない入力は 400

### OC-4: Rebuild / cardinality 観測
- 同一 rawState から 2 回 rebuild → `platformEvents` / `platformLogRefs` を含め完全一致
- attach 候補が複数ある場合も、platform event は最良の 1 incident にのみ attach

### OC-5: CI Green
- `pnpm test` 全 green
- `pnpm typecheck` 全 green
