# Evidence Retention for Non-Trigger Anomalous Spans

**Status**: Backlog
**Origin**: PR #68 レビュー指摘 (blocker)

## 問題

SERVER 429 のような「異常だが incident トリガーにはならない」スパンが、既存 incident の evidence にも記録されずに捨てられる。

### 現状の ingest.ts `/v1/traces` ハンドラ

```
anomalousSpans = spans.filter(isIncidentTrigger)
if (anomalousSpans.length === 0) return { status: "ok" }  // ← 捨てる
...
appendAnomalousSignals(incidentId, buildAnomalousSignals(anomalousSpans))  // trigger spans のみ
```

Stripe 429 だけのバッチが来たとき:
- 新規 incident を作らない → 正しい
- 既存 incident の `rawState` / `triggerSignals` にも残らない → **バグ**

## 設計

`isAnomalous`（evidence 記録）と `isIncidentTrigger`（新規 incident 起動）を分離する。

| 変数 | 用途 | filter |
|------|------|--------|
| `signalSpans` | evidence/signal 記録 | `isAnomalous` |
| `triggerSpans` | 新規 incident 起点判定 | `isIncidentTrigger` |

```
signalSpans = spans.filter(isAnomalous)
triggerSpans = signalSpans.filter(isIncidentTrigger).sort(...)

if (signalSpans.length === 0) return ok

formationKey = buildFormationKey(triggerSpans.length > 0 ? triggerSpans : signalSpans)
existing = find matching incident

if (existing) {
  appendSpans(existing.incidentId, spans)
  appendAnomalousSignals(existing.incidentId, buildAnomalousSignals(signalSpans))
  if (triggerSpans.length > 0) rebuildPacket(...)
  return ok
}

if (triggerSpans.length === 0) return ok  // 既存 incident なし、trigger なし → 新規作成しない

// 新規 incident 作成
createPacket / appendSpans / appendAnomalousSignals(signalSpans) / dispatch
```

## 変更対象

### `apps/receiver/src/transport/ingest.ts`

- `isAnomalous` を import に追加
- `anomalousSpans` → `triggerSpans` + `signalSpans` に分離
- 早期リターン条件: `triggerSpans.length === 0` → `signalSpans.length === 0`
- `buildAnomalousSignals(...)` の引数を `signalSpans` に統一（2 箇所）
- 既存 incident attach: trigger なしでも append、rebuild は trigger ありのときのみ

### `apps/receiver/src/__tests__/integration.test.ts`

新テスト **OC-10**:
- SERVER 500 span で incident を作成
- 同サービスから SERVER 429 のみのバッチを POST
- incident 数が増えない（OC-8 維持）かつ既存 incident の rawState に signals が append されている

## 完了条件

- OC-8 継続 green（SERVER 429 → no new incident）
- OC-9 継続 green
- OC-10 green（新規）
- `pnpm test` 全 green
- `pnpm typecheck` / `pnpm lint` エラーなし
