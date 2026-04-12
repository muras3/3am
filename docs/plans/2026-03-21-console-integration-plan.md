# Console Integration Plan

## Context

receiver / diagnosis / frontend を 3 レーンで並行開発した後、オペレーターが incident 発生時に「何が起きたか・何をするか・なぜ妥当か」を 5 分以内に判断できる体験を成立させるための統合計画。

本 plan は現行 frozen contract に厳密準拠する。contract を広げない。

### Frozen Contract 一覧

| Schema | ファイル | 役割 |
|--------|---------|------|
| `ExtendedIncidentSchema` | `packages/core/src/schemas/incident-detail-extension.ts` | public incident detail response |
| `EvidenceResponseSchema` | `packages/core/src/schemas/curated-evidence.ts` | public evidence response |
| `RuntimeMapResponseSchema` | `packages/core/src/schemas/runtime-map.ts` | public runtime map response |
| `ReasoningStructureSchema` | `packages/core/src/schemas/reasoning-structure.ts` | internal: receiver → diagnosis stage 2 |
| `ConsoleNarrativeSchema` | `packages/core/src/schemas/console-narrative.ts` | internal: diagnosis stage 2 output |

### UI-facing API (3 本のみ)

- `GET /api/runtime-map` → `RuntimeMapResponse`
- `GET /api/incidents/:id` → `ExtendedIncident`
- `GET /api/incidents/:id/evidence` → `EvidenceResponse`

新 endpoint は追加しない。Q&A は `EvidenceResponse.qa` で提供する（pre-generated）。

### Assembly 実装

- `buildRuntimeMap()` — `apps/receiver/src/ambient/runtime-map.ts`
- `buildExtendedIncident()` — `apps/receiver/src/domain/incident-detail-extension.ts`
- `buildCuratedEvidence()` — `apps/receiver/src/domain/curated-evidence.ts`

## 1. 統合順序

**evidence-backed な構造を先に通し、narrative を後から載せる**原則。

### 着手条件 (dependency edge)

| Step | 着手に必要な前提 | 依存先 plan |
|------|----------------|------------|
| Step 1 | `buildRuntimeMap()` が scenario で valid response を返す。`buildIncidentDetailExtension()` が deterministic fields を返す | receiver plan Phase 3+ |
| Step 2 | `buildTraceSurface()` / `buildMetricsSurface()` / `buildLogsSurface()` が scenario で valid response を返す。`toPublic*Surface()` 変換が schema green | receiver plan Phase 4+ |
| Step 3 | `DiagnosisRunner.run()` の stage 1 が scenario で `diagnosisResult` を保存する。`buildExtendedIncident()` の diagnosis merge が動作する | diagnosis plan (stage 1 prompt 検証済み) |
| Step 4 | `buildReasoningStructure()` 実装済み (integration plan deliverable)。`generateConsoleNarrative()` が `ConsoleNarrativeSchema` の全 fields を正しく埋める prompt で動作する。proofCards 3 件 / qa non-null が scenario で確認済み | receiver plan (curated selector 基盤)、diagnosis plan (stage 2 prompt 検証済み) |
| Step 5 | Step 1-4 全完了。frontend が全 3 endpoint で real API 切替済み | frontend plan (fixture → real 切替完了) |

**blocker rule**: 上位 Step の着手条件が未達のまま下位 Step に進まない。着手条件の判定は依存先 plan の実装者と integration 実装者の合意で行う。

### Step 1: Receiver deterministic → Frontend (Map + Incident 骨格)

接続対象:
- `GET /api/runtime-map` → Map 画面
- `GET /api/incidents/:id` (deterministic fields のみ) → Incident Board 骨格

確認事項:
- `RuntimeMapResponse` の nodes/edges/summary/incidents が mock と同等の構造で描画されるか
- `ExtendedIncident` の deterministic fields (`impactSummary`, `blastRadius`, `evidenceSummary`, `state`) が描画可能か
- `state.diagnosis === "pending"` のとき、narrative fields (`headline`, `action`, `causalChain` 等) が空文字/空配列で Incident Board が崩れないか
- **incident 接続**: map の `RuntimeMapIncident.incidentId` で `GET /api/incidents/:id` を取得し、同一 `incidentId` が返ること

### Step 2: Receiver → Frontend (Evidence deterministic surfaces)

接続対象:
- `GET /api/incidents/:id/evidence` → Evidence Studio (deterministic 部分)

`EvidenceResponse` の構造（現行 contract）:
- `surfaces.traces`: `TraceSurface` — `observed[]`, `expected[]`, `smokingGunSpanId`
- `surfaces.metrics`: `MetricsSurface` — `hypotheses[]` (各 `HypothesisGroup` に `id`, `type`, `claim`, `verdict`, `metrics[]`)
- `surfaces.logs`: `LogsSurface` — `claims[]` (各 `LogClaim` に `id`, `type`, `label`, `count`, `entries[]`)
- `state`: diagnosis pending でも surfaces は表示可能

確認事項:
- `TraceSurface.observed` と `.expected` が route / duration で pair として見えるか
- `smokingGunSpanId` に対応する span が `observed` 内に存在しハイライトされるか
- `HypothesisGroup` の各 metric row で `value` / `expected` / `barPercent` が表示されるか
- `LogClaim` の entries が `signal: true/false` で分類表示されるか
- absence type の `LogClaim` (`type: "absence"`) が「expected / observed」で構造的に表示されるか
- **incident 接続**: Step 1 で取得した `incidentId` と同一 ID で evidence を取得し、整合するデータが返ること

Step 1 + 2 で「Map → Incident → Evidence」の deterministic 骨格が一気通貫する。

### Step 3: Diagnosis Stage 1 → Receiver → Frontend (Incident narrative)

接続対象:
- `GET /api/incidents/:id` に `DiagnosisResult` 由来の narrative fields が入る

`ExtendedIncident` の narrative fields (現行 contract):
- `headline`: string
- `action`: `{text, rationale, doNot}`
- `rootCauseHypothesis`: string
- `causalChain`: `[{type: "external"|"system"|"incident"|"impact", tag, title, detail}]`
- `operatorChecks`: string[]
- `confidenceSummary`: `{label, value, basis, risk}`
- `chips`: `[{type: "critical"|"system"|"external", label}]`

確認事項:
- `buildExtendedIncident()` の merge で diagnosis fields が正しく入るか
- `action.text` / `action.rationale` / `action.doNot` が mock の action hero に対応して描画されるか
- `causalChain` の step type (`external | system | incident | impact`) がそれぞれ色分け表示されるか
- diagnosis 結果が Evidence surfaces のデータと矛盾しないか（例: diagnosis が指す service が evidence surface に存在する）

### Step 4: Diagnosis Stage 2 → Receiver → Frontend (Evidence narrative)

**着手前 gate**: `generateConsoleNarrative()` が primary scenario で `ConsoleNarrativeSchema.strict().parse()` green な output を返すことを diagnosis plan 側で確認済みであること。prompt quality が低い場合 (proofCards が schema valid だが semantically 空 / qa.answer が generic すぎる)、integration を進めても UX gate は通らない。

接続対象:
- `GET /api/incidents/:id/evidence` に `ConsoleNarrative` 由来の narrative fields が入る

`EvidenceResponse` の narrative fields (現行 contract):
- `proofCards`: `[{id: "trigger"|"design_gap"|"recovery", label, status: "confirmed"|"inferred"|"pending", summary, targetSurface, evidenceRefs}]`
- `qa`: `{question, answer: string, evidenceRefs, evidenceSummary, followups, noAnswerReason?} | null`
  - `followups`: `[{question, targetEvidenceKinds}]` — 提案のみ。追加 API call なし
  - `noAnswerReason`: string (optional) — answer が生成できない場合の理由
- `sideNotes`: `[{title, text, kind: "confidence"|"uncertainty"|"dependency"}]`

確認事項:
- proof card の `evidenceRefs` (kind: span/log/metric/log_cluster/metric_group, id: string) が surfaces 内の要素と一致し、クリックでハイライトされるか
- `qa.answer` が表示され、`qa.evidenceRefs` で surfaces 要素がハイライトされるか
- `qa.followups` が clickable chip として表示されるか（Phase 1 は表示のみ、追加 API call なし）
- `qa === null` (stage 2 未完了) のとき、Q&A セクションが placeholder 表示されるか
- `sideNotes` が Evidence Studio 右カラムに表示されるか
- proof card の `evidenceRefs[i].id` が surfaces 内の refId / spanId / clusterId / groupId に存在するか（dangling = 0）

### Step 5: End-to-End 検証 (Implementation Gate + UX Gate)

**Step 4 まで完了した状態で** 全体を検証する。§9 の完了条件を判定するステップ。

Implementation Gate 検証:
1. 2 scenario で `Schema.strict().parse()` green (全 3 endpoint)
2. `buildReasoningStructure()` が non-null を返す
3. stage 2 完了 → `qa` non-null、`proofCards` 3 件
4. proof ref 解決率 100%、evidence counts exact match

UX Gate 検証:
5. Map → Incident → Evidence の zoom 遷移で情報連続性
6. 30 秒以内に what happened / what to do / why trust it を読み取れるか
7. `proofCards` → surfaces のハイライトで根拠を辿れるか
8. `qa.answer` を読んで追加理解を得られるか

## 2. Contract Checkpoints

各 Step の統合前に確認が必要な事項。**contract は変更しない。既存 schema に合致するかを確認する。**

### Step 1 の前提

| 確認事項 | 判定基準 | 確認方法 |
|---------|---------|---------|
| `RuntimeMapResponse` が schema 通り返る | `RuntimeMapResponseSchema.parse()` green | scenario 実行 + parse test |
| `ExtendedIncident` の deterministic fields | `impactSummary`, `blastRadius`, `evidenceSummary`, `state` が非 null | scenario 実行 + field check |
| `state.diagnosis === "pending"` 時の graceful degradation | narrative fields が空文字/空配列で返り、parse green | diagnosis 遅延テスト |
| map incident → detail incident 接続 | `RuntimeMapIncident.incidentId` で `GET /api/incidents/:id` が valid response | integration test |
| blast radius の impactValue | `[0, 1]` 範囲内、`displayValue` がパーセント表記 | scenario fixture 確認 |
| node `positionHint` の安定性 | 同一データに対して 3 回 request で同一順序 | stability test |

### Step 2 の前提

| 確認事項 | 判定基準 | 確認方法 |
|---------|---------|---------|
| `EvidenceResponse` が schema 通り返る | `EvidenceResponseSchema.parse()` green | scenario 実行 + parse test |
| `TraceSurface.observed` / `.expected` が存在 | traces 有りの scenario で配列非空 | scenario fixture 確認 |
| `smokingGunSpanId` が `observed` spans 内に存在 | non-null の場合、該当 spanId が spans 配列に含まれる | ref resolution test |
| `HypothesisGroup.metrics` の expected/value | string 型で表示可能 | scenario fixture 確認 |
| absence `LogClaim` (type: "absence") | expected / observed fields が入っている | scenario fixture 確認 |
| `state.diagnosis === "pending"` で surfaces が返る | deterministic surfaces が非空、qa === null | diagnosis 遅延テスト |
| evidence ref の surface 内解決 | proof card 未接続でも spans/metrics/logs の refId が一意 | refId uniqueness test |

### Step 3 の前提

| 確認事項 | 判定基準 | 確認方法 |
|---------|---------|---------|
| `buildExtendedIncident()` が diagnosis result を正しく merge | `headline` / `action.text` / `causalChain` が非空 | scenario + diagnosis 実行 |
| `causalChain[].type` が `"external"\|"system"\|"incident"\|"impact"` | schema parse green | parse test |
| `confidenceSummary.value` が `[0, 1]` | 範囲チェック | scenario fixture 確認 |

### Step 4 の前提

| 確認事項 | 判定基準 | 確認方法 |
|---------|---------|---------|
| `proofCards` が 3 件 (trigger, design_gap, recovery) | `ConsoleNarrative.proofCards.length(3)` 準拠 | narrative 生成 + parse test |
| proof card `evidenceRefs[].id` が surfaces 内に存在 | dangling ref = 0 | ref resolution integration test |
| `qa` が non-null | stage 2 完了後に `QABlock` が返る | narrative 生成テスト |
| `qa.evidenceRefs[].id` が surfaces 内に存在 | dangling ref = 0 | ref resolution integration test |
| `sideNotes` が kind 別に存在 | `"confidence"\|"uncertainty"\|"dependency"` | parse test |

## 3. Fixture → Real API 切り替え条件

frontend は fixture で開発する。real API への切り替えは endpoint 単位で段階的に行う。

### 切り替え判定基準

以下の全てを満たしたとき、該当 endpoint を real API に切り替える。

1. **2 scenario 以上** (`rate_limit_cascade` + `secrets_rotation`) で `Schema.parse()` が green
2. **fixture と public contract の差分なし**: `Schema.strict()` で parse green。fixture にない追加 fields も不可（contract 拡張は schema 変更を経る）
3. **degraded state が 2 パターン以上**: `state.diagnosis === "pending"` + `state.evidenceDensity === "sparse"` の最低 2 つ
4. **evidence ref 解決率 100%**: proof card / qa の全 `evidenceRefs[].id` が surfaces 内に存在 (evidence endpoint のみ)
5. **ordering stability**: 同一データに対して 3 回 request で同一 node/edge/proof card 順序
6. **incident 接続**: map の `incidentId` で incident detail → evidence が取得可能

### 切り替え順序

| 優先度 | Endpoint | 前提 Step |
|--------|----------|----------|
| 1st | `GET /api/incidents/:id` (deterministic) | Step 1 完了 |
| 2nd | `GET /api/runtime-map` | Step 1 完了 |
| 3rd | `GET /api/incidents/:id/evidence` (deterministic) | Step 2 完了 |
| 4th | `GET /api/incidents/:id` (+ diagnosis narrative) | Step 3 完了 |
| 5th | `GET /api/incidents/:id/evidence` (+ narrative) | Step 4 完了 |

### Fixture 管理

- fixture は `apps/console/src/__fixtures__/` に置く
- 各 fixture は対応する Zod schema で validate する
- 各 endpoint に最低 3 パターン: happy path / `state.diagnosis === "pending"` / `state.evidenceDensity === "sparse"` or `"empty"`

## 4. Integration 重点確認事項

### 4.1 Sparse / Degraded / Pending States

以下の 8 状態を integration で明示的に確認する。

| State | 条件 | `state` 値 | 期待される UI |
|-------|------|-----------|-------------|
| diagnosis pending | incident 作成直後 | `diagnosis: "pending"` | action / chain / confidence が placeholder。surfaces は表示可能 |
| no baseline | baseline sample なし | `baseline: "unavailable"` | `TraceSurface.expected = []`。observed のみ。metrics の expected = "—" |
| sparse evidence | traces < 3, logs < 10 | `evidenceDensity: "sparse"` | evidence counts に warning。表示可能分のみ描画 |
| evidence empty | traces 0, metrics 0, logs 0 | `evidenceDensity: "empty"` | surfaces 全て empty state。"Waiting for telemetry data" |
| no representative trace | incident に trace 0 件 | `TraceSurface.observed = []` | traces tab empty。metrics / logs は独立表示 |
| single-node map | service 1 つ | nodes 1 件、edges 0 件 | map が 1 node で成立 |
| Q&A unavailable | stage 2 未完了 | `qa === null` | Q&A セクション placeholder。proof cards も空 |
| Q&A unanswerable | answer 生成不可 | `qa.noAnswerReason` 非空 | reason 表示。followups は提示可能 |

### 4.2 Incident 接続の一貫性

Map → Incident → Evidence で同一コンテキストが保たれることを検証する。

| 検証点 | 確認内容 |
|--------|---------|
| incidentId 一貫性 | `RuntimeMapIncident.incidentId` → `ExtendedIncident.incidentId` → evidence endpoint の path param が同一 |
| incident 存在性 | map node の `incidentId` が non-null の場合、`GET /api/incidents/:id` が valid response を返す |
| evidence 整合性 | `ExtendedIncident.evidenceSummary` の counts が `EvidenceResponse.surfaces` の実データ件数と exact match（両方とも同一 TelemetryStore クエリから deterministic に導出されるため、差分は実装バグ） |
| deterministic → narrative 整合 | `ExtendedIncident.blastRadius` で affected な service が `EvidenceResponse.surfaces` にも出現 |

**注**: `window` / `scope` は raw packet の内部情報であり、public curated response には含まれない。scope 連続性は `incidentId` の一貫性と evidence counts の整合で間接確認する。

### 4.3 Q&A と Evidence Linking

Q&A は pre-generated（`ConsoleNarrative.qa` → `EvidenceResponse.qa`）。追加 API call は Phase 1 では不要。

検証パス:
```
EvidenceResponse.qa.answer (表示)
  → qa.evidenceRefs[i] (kind: "span"|"log"|..., id: string)
  → surfaces 内の対応要素 (spanId / refId / clusterId / groupId)
  → UI ハイライト
```

検証項目:
1. `qa.answer` が表示され、読んで incident の状況を理解できること
2. `qa.evidenceRefs[i].id` が surfaces 内に存在し、ハイライトが発火すること（dangling = 0）
3. `qa.followups` が chip として表示されること（Phase 1 はクリックしても追加 API call しない。表示のみ）
4. `qa === null` のとき Q&A セクションが placeholder 表示されること
5. `qa.noAnswerReason` が非空のとき reason が表示されること

### 4.4 Proof Card → Surface ハイライト

検証パス:
```
proofCards[i].targetSurface (例: "traces")
  → 該当 tab に遷移
  → proofCards[i].evidenceRefs[j] (kind + id)
  → surfaces 内の対応要素をハイライト
```

検証項目:
1. proof card クリックで `targetSurface` の tab に遷移すること
2. `evidenceRefs` の各 ref が surfaces 内に存在すること
3. 存在しない ref は silent skip（UI crash しない）。**frontend は nearest match 推論しない**
4. proof card の `status` (`confirmed` / `inferred` / `pending`) が visual 区別されること

### 4.5 Expected / Observed 表示

**Traces:**
- `TraceSurface.observed` / `.expected` が pair として見えること
- `expected = []` のとき "No baseline trace" 表示
- `smokingGunSpanId` の span がハイライト表示

**Metrics:**
- `HypothesisGroup` ごとに `metrics[].value` / `.expected` / `.barPercent` が表示
- `verdict` (`"Confirmed"` / `"Inferred"`) が badge 表示
- `type` (`"trigger"` / `"cascade"` / `"recovery"` / `"absence"`) でグループヘッダの色分け

**Logs:**
- `LogClaim.entries` の `signal: true/false` で視覚的分類
- `type: "absence"` の LogClaim で `expected` / `observed` が構造表示

### 4.6 Operator Value 検証 (30 秒テスト)

| 判断項目 | 取得元 (frozen contract field) | 確認基準 |
|---------|------|---------|
| 何が起きたか | Map nodes (status/badges) → `ExtendedIncident.headline` | 1 文で状況説明可能 |
| 何をするか | `action.text` | next step が明確 |
| なぜそのアクションか | `action.rationale` + `causalChain` → `proofCards` | action の根拠を evidence まで辿れる |
| 信頼してよいか | `confidenceSummary` (label/basis/risk) → surfaces の expected vs observed | confidence と evidence が矛盾しない |

## 5. Stage 2 Pipeline — 必須 Deliverable

### 現行の問題

`DiagnosisRunner.buildReasoningStructure()` が **placeholder (return null)** のため、stage 2 は常にスキップされる。結果として `consoleNarrative` は永久に null であり、`qa === null`・`proofCards` 空が恒常状態になっている。

この状態は shared assumptions の「Q&A と evidence linking は必須」に反する。integration plan の完了には stage 2 pipeline の接続が必須。

### 必須実装タスク

| タスク | ファイル | 内容 |
|--------|---------|------|
| `DiagnosisRunner` に `TelemetryStoreDriver` 注入 | `apps/receiver/src/runtime/diagnosis-runner.ts` | constructor に `TelemetryStoreDriver` を追加。現行は `StorageDriver` のみで TelemetryStore に触れない。`createApp()` での注入も変更 |
| `buildReasoningStructure()` 実装 | `apps/receiver/src/runtime/diagnosis-runner.ts` | TelemetryStore + StorageDriver から `ReasoningStructure` を組み立てる。proofRefs, blastRadius, absenceCandidates, evidenceCounts, timelineSummary, qaContext を含む。receiver plan の curated selector 基盤を流用 |
| stage 2 実行確認 | `apps/receiver/src/runtime/diagnosis-runner.ts` | `generateConsoleNarrative()` が呼ばれ、`appendConsoleNarrative()` で保存されること |
| stage 2 失敗時の自動 retry | `apps/receiver/src/runtime/diagnosis-runner.ts` | stage 2 失敗時に最低 1 回の自動 retry。retry 後も失敗の場合は error log + `consoleNarrative` は null のまま |
| manual re-run command | `apps/receiver/src/runtime/diagnosis-runner.ts` | `DiagnosisRunner.rerunNarrative(incidentId)` メソッド追加。stage 1 済み incident に対して stage 2 のみ再実行 |
| manual re-run API route | `apps/receiver/src/transport/api.ts` | `POST /api/incidents/:id/regenerate-narrative` — **運用用 internal endpoint。UI-facing API 3 本には含めない。** new console の frontend コードからは呼ばない。CLI / 運用スクリプト専用 |
| DiagnosisRunner DI wiring 変更 | `apps/receiver/src/index.ts` | `new DiagnosisRunner(store)` → `new DiagnosisRunner(store, telemetryStore)` に変更。`createApp()` 内の instantiation と `createIngestRouter()` 経由の wiring を修正。関連テスト (`diagnosis-runner.test.ts` 等) の mock 追加も必須 |
| 既存 incident backfill | integration テストの一部 | stage 1 済み・`consoleNarrative` null の既存 incident に対して `rerunNarrative()` を実行し、null を解消する。integration 完了時に `consoleNarrative === null` の diagnosed incident が 0 件であること |

### Integration で確認する挙動

| 状態 | 期待動作 | 確認方法 |
|------|---------|---------|
| stage 1 未完了 | `state.diagnosis === "pending"`。narrative fields 空。surfaces は表示可能 | diagnosis 遅延テスト |
| stage 1 完了、stage 2 未完了 (一時的) | narrative fields 入り (headline, action 等)。`qa === null` は **一時的にのみ** 許容 | stage 2 遅延テスト |
| stage 2 失敗 → auto retry 成功 | retry で `consoleNarrative` が保存される。`qa` non-null になる | error injection + retry テスト |
| stage 2 失敗 → auto retry も失敗 | error log 出力。`consoleNarrative` は null のまま。**plan 完了条件は未達 — `rerunNarrative()` で manual re-run が必要** | error injection テスト |
| manual re-run (`rerunNarrative()`) | 既存 diagnosed incident の stage 2 を再実行。成功すれば `consoleNarrative` 保存 | backfill テスト |
| stage 2 完了 (正常) | `qa` non-null、`proofCards` 3 件、`sideNotes` 入り | full flow test |

### 5.1 Evidence Counts Canonical Rule

現行コードには counting 定義の不一致がある:

| フィールド | `incident-detail-extension.ts` の定義 | `curated-evidence.ts` の定義 |
|-----------|--------------------------------------|------------------------------|
| traces | `unique traceId count` (raw spans から) | `observed trace GROUP count` (curated groups の配列長) |
| metrics | `raw metric row count` | `metric ROW count within groups` (groups.reduce rows) |
| logs | `raw log entry count` | `log ENTRY count within clusters` (clusters.reduce entries) |

**canonical rule**: `ExtendedIncident.evidenceSummary` が canonical とする。理由: incident detail は curated evidence よりも上位の集約面であり、operator が最初に見る数値。surfaces 側の count はこの数値と exact match すること。

現行コードの不一致を解消する方法:
- `curated-evidence.ts` の `evidenceDensity` 算出時の `traceCount` を unique traceId count に揃える
- または `incident-detail-extension.ts` 側を curated group count に揃える

**integration plan の判断**: canonical は `ExtendedIncident.evidenceSummary` の counting rule に固定する:
- `traces` = unique traceId count
- `traceErrors` = error span count (status 500+ or spanStatus 2 or exception)
- `metrics` = raw metric row count
- `logs` = raw log entry count
- `logErrors` = ERROR/FATAL severity log count

`curated-evidence.ts` の `evidenceDensity` 算出で使う count もこの canonical rule に揃える。不一致は integration blocker。

### `qa === null` の位置づけ

- **一時的状態** (stage 2 処理中): 許容。frontend は placeholder 表示
- **恒常状態** (stage 2 未実装 / pipeline 未接続): **plan 完了条件に反する。禁止**
- integration 完了時点で、diagnosed incident に対して `qa` が non-null であること

## 6. 必要な Test

### Integration Test Suite

| Test | Step | 検証内容 |
|------|------|---------|
| `runtime-map-schema-valid` | 1 | `RuntimeMapResponseSchema.parse()` green |
| `incident-deterministic-schema-valid` | 1 | `ExtendedIncidentSchema.parse()` green (deterministic fields 非空) |
| `incident-pending-graceful` | 1 | `state.diagnosis === "pending"` → narrative 空で parse green |
| `map-to-incident-id-match` | 1 | map `incidentId` → detail `incidentId` 一致 |
| `evidence-schema-valid` | 2 | `EvidenceResponseSchema.parse()` green |
| `evidence-smoking-gun-exists` | 2 | `smokingGunSpanId` が observed spans に含まれる |
| `evidence-absence-claim` | 2 | `LogClaim` type "absence" が expected/observed 付き |
| `evidence-pending-surfaces` | 2 | `state.diagnosis === "pending"` → surfaces 非空、qa === null |
| `evidence-empty-density` | 2 | evidence 0 → surfaces 全空、`state.evidenceDensity === "empty"` |
| `evidence-no-trace` | 2 | trace 0 → `TraceSurface.observed = []` |
| `evidence-counts-exact-match` | 2 | `ExtendedIncident.evidenceSummary` counts と surfaces 実データ件数が canonical rule で exact match (§5.1 参照) |
| `incident-narrative-merge` | 3 | diagnosis 完了 → `headline` / `action.text` / `causalChain` 非空 |
| `causal-chain-types` | 3 | type が `external\|system\|incident\|impact` のいずれか |
| `proof-card-ref-resolution` | 4 | proofCards の全 `evidenceRefs[].id` が surfaces 内に存在 |
| `qa-ref-resolution` | 4 | `qa.evidenceRefs[].id` が surfaces 内に存在 |
| `qa-null-placeholder` | 4 | `qa === null` → placeholder UI |
| `qa-unanswerable` | 4 | `noAnswerReason` 非空 → reason 表示 |
| `reasoning-structure-valid` | 4 | `buildReasoningStructure()` が `ReasoningStructureSchema.parse()` green な値を返す |
| `stage2-pipeline-connected` | 4 | `DiagnosisRunner.run()` → stage 1 + stage 2 実行 → `consoleNarrative` 保存 |
| `stage2-retry-on-failure` | 4 | stage 2 失敗 → retry → 成功時 `consoleNarrative` 保存 |
| `diagnosed-incident-qa-nonnull` | 4 | stage 1+2 完了 incident で `qa` non-null |
| `diagnosed-incident-proofcards-3` | 4 | stage 1+2 完了 incident で `proofCards` 3 件 |
| `full-zoom-flow` | 5 | Map → Incident → Evidence の zoom 遷移 |
| `operator-30sec-test` | 5 | 4 判断項目を 30 秒以内に読取可能 |
| `degraded-no-baseline` | 5 | `baseline: "unavailable"` → expected 空で fallback 表示 |
| `degraded-sparse` | 5 | `evidenceDensity: "sparse"` → warning + 表示可能分 |
| `degraded-single-node` | 5 | 1 node map が成立 |

### Scenario 割り当て

| Scenario | 用途 |
|----------|------|
| `third_party_api_rate_limit_cascade` | primary — 全 surface、absence evidence (retry/backoff) |
| `secrets_rotation_partial_propagation` | secondary — 異なる causal chain、incident 接続確認 |
| `upstream_cdn_stale_cache_poison` | degraded — sparse baseline |
| (minimal synthetic) | empty — trace 0, service 1, evidence density empty |

## 7. Old / New API 共存ルール (§3.8)

- new console の主経路は curated API 3 本のみ
- 既存 raw API (`/api/services`, `/api/activity`, `/api/incidents/:id/telemetry/*`) は debug / CLI 用に残す。削除しない
- `/api/chat/:id` は凍結 → 段階的廃止（Q&A は `EvidenceResponse.qa` に統合済み）
- new console の frontend コードから raw API / chat API を直接 import しない

## 8. リスク

| 重大度 | リスク | 対策 |
|--------|--------|------|
| HIGH | stage 2 遅延で `qa === null` が一時的に発生 | Step 2 で evidence deterministic surfaces が先に動く設計で一時的に許容。ただし diagnosed incident で恒常的に `qa === null` は plan 未完了。stage 2 retry で回復する |
| HIGH | `buildReasoningStructure()` の実装が receiver plan deliverable と重なる | receiver plan の curated selector 基盤を流用する。blast radius / proof refs / absence candidates の derivation は receiver plan で先に実装し、`buildReasoningStructure()` はそれを組み立てるだけ |
| HIGH | proof card `evidenceRefs[].id` が surfaces 内に存在しない (dangling) | receiver の proof ref builder が ID を生成し、diagnosis はそれを参照するだけ。Step 4 で ref resolution 100% を gate にする |
| HIGH | `buildExtendedIncident()` の diagnosis merge で field 欠落 | `diagnosisResult` 欠損時の graceful degradation が既に実装済み。Step 1 の pending test で確認 |
| MEDIUM | fixture と real API の乖離 | Zod schema で fixture を validate。切り替えは endpoint 単位で段階的に |
| MEDIUM | degraded state の組み合わせ | 8 state を定義し各 Step で 1-2 確認。全組み合わせはテストしない |
| MEDIUM | `qa.evidenceRefs` の kind が surfaces の ID 体系と不一致 | `AnswerEvidenceRefSchema` の kind (`span|log|metric|log_cluster|metric_group`) と surfaces 内の ID 体系を Step 4 で cross-check |
| LOW | zoom transition が大量データで重い | 全 Step 完了後に performance pass |

## 9. 完了条件

**Step 4 まで完了しなければ未完。** Step 1-3 は中間状態であり、plan の完了とはみなさない。

contract は変更しない。implementation gate と UX gate の両方を満たすこと。

### Implementation Gate (必須 — Step 4 まで入って初めて判定可能)

**Pipeline 接続:**
1. **`buildReasoningStructure()` 実装済み**: placeholder ではなく、`ReasoningStructureSchema.parse()` green な構造を返す
2. **`DiagnosisRunner` DI 完了**: constructor に `TelemetryStoreDriver` 注入済み。`createApp()` / `createIngestRouter()` の wiring 変更済み。関連テスト更新済み
3. **stage 2 pipeline 接続済み**: `DiagnosisRunner.run()` が stage 1 → stage 2 を実行し、`appendConsoleNarrative()` で保存する
4. **stage 2 auto retry + manual re-run**: stage 2 失敗時に自動 retry。retry も失敗なら `rerunNarrative()` + `POST /api/incidents/:id/regenerate-narrative` (運用用 internal endpoint) で再実行可能

**Diagnosed incident の状態 (恒常状態として):**
5. **`consoleNarrative !== null`**: diagnosed incident (stage 1 完了) で `consoleNarrative === null` が 0 件。既存 incident の backfill 完了
6. **`qa` non-null**: diagnosed incident で `EvidenceResponse.qa` が non-null。一時的 null (処理中) は許容するが恒常 null は禁止
7. **`proofCards` 3 件**: diagnosed incident で `proofCards` が trigger / design_gap / recovery の 3 件。空配列は禁止

**Contract 整合:**
8. **3 curated endpoint が schema valid**: 2 scenario 以上で `Schema.strict().parse()` green
9. **incident 接続**: map `incidentId` → incident detail → evidence が一貫
10. **proof ref 解決率 100%**: proofCards + qa の全 `evidenceRefs[].id` が surfaces 内に存在
11. **evidence counts exact match**: `ExtendedIncident.evidenceSummary` counts と surfaces 実データ件数が canonical rule (§5.1) で一致
12. **expected vs observed 成立**: traces / metrics surfaces で baseline comparison 表示 (baseline ありの場合)
13. **absence evidence 表示**: `LogClaim` type "absence" が 1 件以上構造表示

**Degraded + 境界:**
14. **8 degraded states 全て非 crash**: §4.1 の全状態で UI が crash せず fallback 表示
15. **old API 非依存 + internal endpoint 隔離**: new console の frontend コードから raw / chat endpoint および `POST regenerate-narrative` への直接 import・呼び出しが一切ない。`POST regenerate-narrative` は CLI / 運用スクリプト専用であり、console UI にボタン・リンク・hidden trigger を設けない。product contract (UI-facing API 3 本) には含めない
16. **2 scenario 以上で通過**: primary + secondary の両方で 1-15 成立

### UX Gate (必須 — implementation gate green の後に検証)

17. **正しい初動を選べる**: `action.text` を読んで正しい recovery action を特定できる
18. **根拠を辿れる**: `action.rationale` → `causalChain` → `proofCards` → surfaces のハイライトまで辿って、action の妥当性を判断できる
19. **5 分以内に初動判断**: Map 発見 → Evidence 確認まで 5 分以内に initial action を決定できる
20. **Q&A で追加確認**: `qa.answer` を読んで追加の理解を得られる。`evidenceRefs` が surfaces に正しくリンクしている
21. **zoom 遷移が情報連続**: Map → Incident → Evidence の遷移で context が途切れない

### 禁止事項 (plan 完了を宣言できない状態)

- `buildReasoningStructure()` が placeholder (return null) のまま
- `DiagnosisRunner` が `TelemetryStoreDriver` を注入されていない
- diagnosed incident (stage 1 完了) で `consoleNarrative === null` が 1 件でも残っている
- diagnosed incident で `qa === null` が恒常状態
- diagnosed incident で `proofCards` が 3 件未満（trigger / design_gap / recovery の全件が必須）
- `evidenceSummary` counts と surfaces 件数に不一致がある（counting rule 未統一）
- stage 2 失敗時の manual re-run 手段 (`rerunNarrative()` + API route) が未実装
- console UI から `POST regenerate-narrative` を呼ぶボタン・リンク・hidden trigger がある
- Step 1-3 のみ完了で "骨格は通った" と報告
