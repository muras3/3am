# Plan 7: Retrieval Layer Completion (B-5)

## Series Context

```
Wave 1:  ✅ Plan 1 (A-1+B-3)
Wave 2:  ✅ Plan 2 (A-2)  |  ✅ Plan 3 (B-1)  |  ✅ Plan 4 (B-2)
Wave 3:  Plan 5 (A-3)  |  Plan 6 (B-4)  |  ▶ Plan 7 (B-5)  |  Plan 8 (B-6)  ← 並列可
```

Depends on: Plan 1 (rebuild 基盤)、Plan 6 (typed evidence — refs の source)

## Execution Model

1. `develop` から `feat/packet-remediation-b5` ブランチを切る
2. **TeamCreate** (Sonnet) で実装 (ADR 変更なし)
3. `/simplify` 実行
4. PR → Opus レビュー → 修正 (最大 3 ラウンド)
5. Observable completion criteria 検証

## Why

`pointers` に `traceRefs` しか入らず、metric/log/platform event への retrieval path がない。Evidence Studio や deep dive の土台が欠けている。

## Current State

- `PointersSchema`: `{ traceRefs: string[], logRefs: string[], metricRefs: string[], platformLogRefs: string[] }`
- `createPacket()` (packetizer.ts): `traceRefs` のみ populate (deduplicated traceIds)
- `logRefs`, `metricRefs`, `platformLogRefs` は常に空配列

## What to Change

### 1. Core schema 変更 (`packages/core/src/schemas/incident-packet.ts`)
- pointer ref types を structured に変更するか検討
  - Option A: `string[]` のまま、formatted string (e.g., `"metric::{name}::{service}::{ts}"`)
  - Option B: typed ref objects (e.g., `{ metricName, serviceName, timestamp }`)
  - 推奨: Option B (型安全、UI/diagnosis が parse 不要)

### 2. Packetizer / rebuild 変更
- `pointers.logRefs`: relevantLogs から再取得キー生成
- `pointers.metricRefs`: changedMetrics から再取得キー生成
- `pointers.platformLogRefs`: platformEvents (Plan 5 後) から再取得キー生成
- rebuild 時に evidence から refs を自動導出

### 3. テスト
- rebuild 後に各 refs が非空であることの確認
- refs と evidence entries の対応確認

## Sonnet 並列化

- Agent A: Core schema (pointer ref types)
- Agent B: Packetizer の retrieval 生成ロジック + テスト

## Observable Completion Criteria

### OC-1: Retrieval 充填観測
metrics + logs を含む incident で:
- `packet.pointers.traceRefs` 非空 (既存)
- `packet.pointers.logRefs` 非空 (新規)
- `packet.pointers.metricRefs` 非空 (新規)

### OC-2: Refs→Evidence 対応観測
- 各 ref が対応する evidence entry を特定可能

### OC-3: CI Green
- `pnpm test` 全 green
- `pnpm typecheck` 全 green
