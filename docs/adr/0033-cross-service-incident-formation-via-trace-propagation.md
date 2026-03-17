# ADR 0033: Cross-Service Incident Formation via Trace Propagation

- Status: Proposed
- Date: 2026-03-17
- Amends: ADR 0017 (Incident Formation Rules v1)

## Context

### 検証で発覚した問題

`cascading_timeout_downstream_dependency` シナリオを Railway staging で実行した結果、以下の packet が生成された:

```json
{
  "primaryService": "unknown_service:node",
  "affectedServices": ["unknown_service:node"],
  "affectedDependencies": [],
  "changedMetrics": []
}
```

Ground truth が求める因果関係:

```
notification-svc latency spike (100ms → 8s)
  → web の worker pool 枯渇 (16/16)
  → /checkout が巻き添え 504 (notification 依存なし)
```

LLM 診断スコア: **5/8**（root cause accuracy 1/2, causal chain coherence 1/2）

**診断精度の問題ではなく、packet に web 側のデータが含まれていないことが原因。** LLM は与えられた evidence の範囲では妥当な診断をしていた。

### 根本原因の分析

ADR 0017 の formation ルールは以下の 2 つの軸で incident をまとめる:

1. **Same service** — `primaryService` が同じ
2. **Same dependency** — `peer.service` (normalized) が同じ

`cascading_timeout` シナリオでは:

- notification-svc の slow span → `primaryService: "notification-svc"`, `dependency: undefined`
- web の 504 span → `primaryService: "validation-web"`, `dependency: undefined`

どちらのルールにも該当しないため、**別 incident として扱われる**（または web の anomaly が notification-svc の incident に attach されない）。

しかし OTel の distributed trace では、web → notification-svc の呼び出しが **同一 traceId** に属している。この情報を使えば因果関係を辿れる。

### パイプライン上の位置づけ

```
ingest → formation → attach evidence → scoring (ADR 0032) → packet → LLM
          ^^^^^^^^     ^^^^^^^^^^^^^^^
          本 ADR        本 ADR
```

ADR 0032 が改善した scoring（Layer 2）は正しく機能している（`third_party_api_rate_limit_cascade` で 8/8 を確認）。本 ADR は scoring の上流にある formation と evidence attach を改善する。

## Decision

### 1. Trace-based cross-service merge

同一 `traceId` に属する anomalous span が複数の service にまたがる場合、それらを同一 incident に merge する。

```
既存ルール (ADR 0017):
  environment + time window + (primaryService OR dependency)

追加ルール (本 ADR):
  environment + time window + shared traceId with anomalous spans
```

#### アルゴリズム

新しい anomalous span batch が到着したとき:

1. **既存ルール (ADR 0017) を先に評価** — primaryService または dependency で既存 incident にマッチすれば、従来通り attach
2. **マッチしない場合、traceId による cross-service lookup を実行**:
   a. 新 batch の anomalous span から `traceId` の集合を取得
   b. 既存 open incident の `pointers.traceRefs` と intersection を取る
   c. intersection が空でなければ、その incident に merge する
3. **`MAX_CROSS_SERVICE_MERGE` ガードは維持** — ADR 0017 の上限 (=3) を超える merge は行わない

#### 優先順位

```
1. ADR 0017 primaryService match  (最優先)
2. ADR 0017 dependency match
3. 本 ADR: traceId cross-service match  (新規)
4. 新規 incident 作成  (フォールバック)
```

trace match は既存ルールの **フォールバック拡張** であり、既存の formation ロジックを置き換えない。

### 2. Evidence attach scope の拡張

現在の evidence attach は `affectedServices` に含まれるサービスのデータのみを対象とする。trace-based merge により `affectedServices` が複数サービスに拡がるため、TelemetryStore クエリ（ADR 0032 snapshot-builder）の `services` パラメータが自然に拡張される。

追加の変更は不要 — snapshot-builder の `computeWindowAndScope()` は既に `rawState.spans` の全 serviceName を収集しており、merge によって web + notification-svc の span が同一 rawState に入れば、両方の metrics/logs が自動的に選別対象になる。

### 3. 非目標

- **Full dependency graph construction** — service 間の呼び出し関係を永続的な graph として構築・維持することは行わない。trace propagation は個々のリクエスト単位で因果を辿る手段であり、graph は不要
- **Non-anomalous trace correlation** — 正常な span のみの trace は merge の対象外。少なくとも 1 つの anomalous span を含む trace のみが対象
- **traceId のみに基づく mega-incident** — `MAX_CROSS_SERVICE_MERGE` ガードにより、同一 traceId であっても 4 サービス以上の pull-in は防止される

## Implementation Notes

### formation.ts の変更

`shouldAttachToIncident()` に第 3 の分岐を追加:

```typescript
// 既存: dependency match / primaryService match

// 新規: trace-based cross-service match
if (sharedTraceIds.length > 0 && scope.affectedServices.length < MAX_CROSS_SERVICE_MERGE) {
  return true
}
```

`sharedTraceIds` の計算には、新 batch の anomalous span の traceId と既存 incident の `pointers.traceRefs` の intersection を使う。

### パフォーマンス考慮

- `pointers.traceRefs` は最大 30 件 (ADR 0032)。open incident 数は通常 1-5 件。intersection 計算は Set lookup で O(n) — パフォーマンス問題にならない
- TelemetryStore のクエリは既存の snapshot-builder フローを再利用。追加クエリは不要

### Validation stack の前提修正

本 ADR の効果を検証するには、`mock-notification-svc` の `OTEL_SERVICE_NAME` 設定が必要（現在未設定のため `unknown_service:node` になっている）。これは validation stack のバグであり、本 ADR とは独立して修正する。

## Consequences

- `cascading_timeout` のような cross-service cascade シナリオで、原因サービスと被害サービスが同一 incident にまとまる
- LLM が因果関係の全体像（notification-svc slow → web worker pool 枯渇 → checkout 504）を見られるようになり、診断精度が向上する見込み
- 既存の formation ルール（ADR 0017）は変更されない。trace match は優先順位 3 のフォールバック拡張
- `MAX_CROSS_SERVICE_MERGE` ガードにより、mega-incident のリスクは ADR 0017 と同等
- OTel の trace context propagation が正しく設定されていない環境では効果がない（trace propagation は OTel の基本機能であり、instrumentation minimum requirements (ADR 0023) の範囲内）

## Related

- [ADR 0017: Incident Formation Rules v1](0017-incident-formation-rules-v1.md) — 本 ADR が amend する対象
- [ADR 0008: Problem Grouping and Packetization Without LLM](0008-problem-grouping-and-packetization-without-llm.md) — formation が LLM なしで行われる設計原則
- [ADR 0032: TelemetryStore and Evidence Selection](0032-telemetry-store-and-evidence-selection.md) — scoring/selection パイプライン。本 ADR は scoring の上流を改善
- [ADR 0018: Incident Packet Semantic Sections](0018-incident-packet-semantic-sections.md) — packet の scope.affectedServices が拡張される
- [ADR 0023: Instrumentation Minimum Requirements](0023-instrumentation-minimum-requirements.md) — trace context propagation が前提
