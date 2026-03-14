# Plan 8: Observed Signal Severity (B-6)

## Series Context

```
Wave 1:  ✅ Plan 1 (A-1+B-3)
Wave 2:  ✅ Plan 2 (A-2)  |  ✅ Plan 3 (B-1)  |  ✅ Plan 4 (B-2)
Wave 3:  Plan 5 (A-3)  |  Plan 6 (B-4)  |  Plan 7 (B-5)  |  ▶ Plan 8 (B-6)  ← 並列可
```

Depends on: Plan 1 (rebuild 基盤)、Plan 6 (evidence typing — severity 導出の input)

## Execution Model

1. `develop` から `feat/packet-remediation-b6` ブランチを切る
2. **TeamCreate** (Sonnet) で実装 (ADR 変更なし — schema 変更のみ)
3. `/simplify` 実行
4. PR → Opus レビュー → 修正 (最大 3 ラウンド)
5. Observable completion criteria 検証

## Why

`severity` が optional で通常 unset。incident の signal 強度を packet 単体で表せない。ただし business severity と混同してはならない。

## Current State

- `IncidentPacketSchema`: `severity: z.string().optional()` — 使われていない
- `createPacket()`: severity を設定しない
- formation / ingest でも severity は一切触れない

## What to Change

### 1. Core schema 変更 (`packages/core/src/schemas/incident-packet.ts`)
- `severity` → `signalSeverity` にリネーム (明確化)
- `SignalSeveritySchema`: `z.enum(["critical", "high", "medium", "low"])`
- 導出ルール (deterministic):
  - `critical`: 5xx burst (5+ spans) OR exception storm (5+ exceptions)
  - `high`: 429 OR error status (spanStatusCode=2) OR 5xx (< 5 spans)
  - `medium`: slow spans (> 5000ms) のみ
  - `low`: minor anomaly (単発 exception 等)

### 2. Packetizer / rebuild 変更
- `computeSignalSeverity(anomalousSignals)` 関数追加
- rebuild 時に毎回再計算
- 新 signal 追加で severity が変わりうる (e.g., medium → critical)

### 3. 明文化
- code comment: "signalSeverity is observed signal strength, NOT business impact severity"
- schema description に同様の注記

### 4. テスト
- 各 severity level の導出テスト
- rebuild 後の再計算テスト
- business severity との非混同をドキュメント/コメントで確認

## Sonnet 並列化

単一タスク。Agent 1 体で十分。

## Observable Completion Criteria

### OC-1: 導出観測
- 5xx burst (5+ spans) → `signalSeverity === "critical"`
- 429 単発 → `signalSeverity === "high"`
- slow span のみ → `signalSeverity === "medium"`

### OC-2: Rebuild 再計算観測
- Batch 1: slow span → medium → Batch 2: 5xx burst → critical

### OC-3: 非混同観測
- schema/code/test で "observed signal strength" と明記されている

### OC-4: CI Green
- `pnpm test` 全 green
- `pnpm typecheck` 全 green
