# Plan 6: Evidence Schema Typing (B-4)

## Series Context

```
Wave 1:  ✅ Plan 1 (A-1+B-3)
Wave 2:  ✅ Plan 2 (A-2)  |  ✅ Plan 3 (B-1)  |  ✅ Plan 4 (B-2)
Wave 3:  Plan 5 (A-3)  |  ▶ Plan 6 (B-4)  |  Plan 7 (B-5)  |  Plan 8 (B-6)  ← 並列可
```

Depends on: Plan 1 (rebuild 基盤)

## Execution Model

1. `develop` から `feat/packet-remediation-b4` ブランチを切る
2. **ADR 0023 更新 → ユーザー承認**
3. **TeamCreate** (Sonnet) で実装
4. `/simplify` 実行
5. PR → Opus レビュー → 修正 (最大 3 ラウンド)
6. Observable completion criteria 検証

## Why

`changedMetrics` と `relevantLogs` が `unknown[]` で downstream contract が弱い。UI/diagnosis/storage 間の drift を防げない。

## Current State

- `EvidenceSchema` (incident-packet.ts): `changedMetrics: z.array(z.unknown())`, `relevantLogs: z.array(z.unknown())`
- `extractMetricEvidence()` (evidence-extractor.ts): 構造化された object を返すが、schema 上は unknown
- `extractLogEvidence()`: 同上
- 実質 typed だが contract として保証されていない

## What to Change

### 1. ADR 0023 更新
- evidence type ごとの minimum shape を補足
- observed signal severity と business severity の分離を明記

### 2. Core schema 変更 (`packages/core/src/schemas/incident-packet.ts`)
- `ChangedMetricSchema`: `{ metricName, metricType, serviceName, environment, timestamp, value?, unit?, delta? }`
- `RelevantLogSchema`: `{ timestamp, severityNumber, severityText, serviceName, body, traceId?, spanId? }`
- `evidence.changedMetrics` → `ChangedMetricSchema[]`
- `evidence.relevantLogs` → `RelevantLogSchema[]`

### 3. Evidence extractor 更新 (`apps/receiver/src/domain/evidence-extractor.ts`)
- output を新 schema に適合させる (既に近い shape のはずだが、strict 準拠に)

### 4. 既存テスト更新
- evidence-extractor.test.ts: assertion を新 schema に合わせる
- integration.test.ts: evidence accumulation テストを更新

## Sonnet 並列化

- Agent A: Core schema 定義 + ADR 0023 更新
- Agent B: evidence-extractor.ts 更新 + テスト

## Observable Completion Criteria

### OC-1: 型安全観測
- `IncidentPacketSchema.parse(packet)` が typed array で通る (`unknown[]` でない)

### OC-2: Extractor 適合観測
- `extractMetricEvidence()` 返り値が `ChangedMetricSchema.parse()` で通る
- `extractLogEvidence()` 返り値が `RelevantLogSchema.parse()` で通る

### OC-3: 破壊的変更なし
- 既存 integration test が新 schema で green

### OC-4: CI Green
- `pnpm test` 全 green
- `pnpm typecheck` 全 green
