# Phase B ADR and Security Review

- Date: 2026-03-08
- Scope: `develop` after PR #39 (`feat/phase-a-core-contracts`)
- Reviewer focus:
  - ADR compliance (`0015`-`0026`)
  - security / secure-by-default review

## Executive Summary

現在の実装は **Phase B 完了ではなく、実質 Phase A 完了に近い**。  
`packages/core` に契約スキーマとテストが入り始めている点は良いが、Receiver / Console 本体は未着手に近く、契約の厳格さと実行可能性にも不足がある。

最優先で直すべきなのは以下。

1. `IncidentPacketSchema` / `DiagnosisResultSchema` を strict にして unknown field を reject する
2. string / array / object の制約を追加して contract を tighten する
3. `z.unknown()` の多用を減らし、evidence/pointers に最低限の shape を与える
4. `packages/core` の test / typecheck / lint を実行可能にする

## Findings

### F-001

- Severity: High
- Category: ADR compliance / delivery accuracy
- Location:
  - [apps/receiver/package.json](/Users/murase/project/3amoncall/apps/receiver/package.json#L1)
  - [apps/console/package.json](/Users/murase/project/3amoncall/apps/console/package.json#L1)
- Evidence:
  - `apps/receiver` は `package.json` のみで `src/` が存在しない
  - `apps/console` も `package.json` のみで実装がない
- Impact:
  - ADR 0021/0022/0023/0025 で定義された Receiver / Console の責務はまだコードに存在せず、`Phase B 完了` という認識は誤りになる
- Fix:
  - 現時点の成果は `Phase A (contracts)` として扱う
  - README / worklog / 実装計画側で誤認を招く表現を避ける

### F-002

- Severity: High
- Category: Contract integrity / security
- Location:
  - [incident-packet.ts](/Users/murase/project/3amoncall/packages/core/src/schemas/incident-packet.ts#L23)
  - [incident-packet.ts](/Users/murase/project/3amoncall/packages/core/src/schemas/incident-packet.ts#L30)
- Evidence:
  - `changedMetrics`, `representativeTraces`, `relevantLogs`, `platformEvents`, `traceRefs`, `logRefs`, `metricRefs`, `platformLogRefs` がすべて `z.array(z.unknown())`
- Impact:
  - arbitrary payload を受け入れやすく、packet のサイズ膨張や raw data 過剰格納を防げない
  - ADR 0018 の canonical model として弱い
- Fix:
  - 詳細 schema が未確定でも、最低限 `id`, `kind`, `ts`, `service`, `summary` などの shape を定義する

### F-003

- Severity: Medium
- Category: Contract integrity / security
- Location:
  - [incident-packet.ts](/Users/murase/project/3amoncall/packages/core/src/schemas/incident-packet.ts#L37)
  - [diagnosis-result.ts](/Users/murase/project/3amoncall/packages/core/src/schemas/diagnosis-result.ts#L15)
- Evidence:
  - `IncidentPacketSchema` と `DiagnosisResultSchema` は `z.object(...)` で定義され、strict ではない
  - `ThinEventSchema` だけは `z.strictObject(...)`
- Impact:
  - unknown fields が silently strip され、over-posting や contract drift を見逃しやすい
  - secret や余計な raw data が混入しても reject できない
- Fix:
  - packet / diagnosis result も strict にして unknown field を reject する

### F-004

- Severity: Medium
- Category: Validation robustness
- Location:
  - [incident-packet.ts](/Users/murase/project/3amoncall/packages/core/src/schemas/incident-packet.ts#L3)
  - [diagnosis-result.ts](/Users/murase/project/3amoncall/packages/core/src/schemas/diagnosis-result.ts#L3)
  - [incident-formation.ts](/Users/murase/project/3amoncall/packages/core/src/schemas/incident-formation.ts#L7)
- Evidence:
  - timestamps, ids, summaries, watch items, metadata fields が単なる `z.string()`
- Impact:
  - 異常に長い値、不正フォーマット、予期しない識別子を防げない
  - 外部入力境界として弱い
- Fix:
  - `.datetime()` / regex / `.max()` / `.min()` を導入する
  - arrays にも最大件数を設ける

### F-005

- Severity: Medium
- Category: Build/test readiness
- Location:
  - [packages/core/package.json](/Users/murase/project/3amoncall/packages/core/package.json#L14)
  - [packages/config-typescript/package.json](/Users/murase/project/3amoncall/packages/config-typescript/package.json#L1)
  - [packages/config-eslint/package.json](/Users/murase/project/3amoncall/packages/config-eslint/package.json#L1)
- Evidence:
  - `pnpm --filter @3amoncall/core test` → `vitest: command not found`
  - `pnpm --filter @3amoncall/core typecheck` → `zod`, `vitest`, shared tsconfig を解決できない
  - `pnpm --filter @3amoncall/core lint` → `eslint: command not found`
- Impact:
  - Phase A の「contract-first / test-first」がローカルで実行できない
  - Claude / Sonnet 実装の feedback loop が壊れる
- Fix:
  - workspace install 前提を明示する
  - package dependencies / root scripts / shared config 解決を見直し、test/typecheck/lint が実行可能な状態にする

## Security Notes

- 現時点で重大な secret leakage や obvious injection は見えない
- ただし `contract が緩すぎる` こと自体がセキュリティ上の問題
- 特に packet / diagnosis result に任意フィールドを受け入れうる状態は早めに tighten すべき

## Recommended Next Step

1. `packages/core` の schema 厳格化
2. `packages/core` の test/typecheck/lint 実行性回復
3. `Phase A 完了 / Phase B 未着手` の認識を明示
4. その後に Receiver Core へ進む
