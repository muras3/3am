# Lane B: Ambient Read Model Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** receiver に ambient surface 用の read model を追加し、console normal mode が消費する `GET /api/services` と `GET /api/activity` を実装する。

**Architecture:** OTLP ingest パイプラインの前段に in-memory SpanBuffer（max 1000、TTL 5min）を挿入し、全スパン（正常・異常問わず）を記録する。バッファから ServiceSurface[] と RecentActivity[] をオンデマンド計算し、Console の normal mode に提供する。StorageDriver は変更しない（ADR 0013 準拠）。コールドスタートでリセットされる best-effort ambient として許容する。

**Tech Stack:** TypeScript, Hono, Vitest, @hono/node-server (existing receiver deps)

---

## Lane 配置

```
Lane A (console):  Phase 0 → Phase 1 → Phase 2 → Phase 4
Lane B (receiver): このプラン（Phase 3）──────────────────────┐
                                                              ↓
                                          Lane A Phase 2 完了後に console が消費
```

Lane B は develop へ独立してマージできる。Lane A Phase 2 が完了したら console 側がこのエンドポイントを消費する。

---

## フェーズ構成

```
Phase 0: ADR 0029 作成・合意（実装前に人間が承認すること）
Phase 1: 型定義（全エージェントへの gate）
Phase 2: TeamCreate 並列実装（domain / transport）
Phase 3: 統合 + E2E テスト
Phase 4: opus 4.6 レビュー
```

---

## Phase 0: ADR 0029 作成と合意

**⛔ これが承認されるまで Phase 1 以降に進んではいけない。**

### Task 0-1: ADR 0029 を作成する

- ファイル: `docs/adr/0029-ambient-read-model.md`

ADR に含めるべき決定事項:

| 項目 | 決定内容 |
|------|---------|
| ストレージ方針 | in-memory のみ。コールドスタートでリセット。StorageDriver には触らない（ADR 0013 準拠） |
| バッファ仕様 | max 1000 spans、TTL 5min。ring buffer（古いものを push-out） |
| 注入方式 | `createIngestRouter(storage, spanBuffer?)` / `createApiRouter(storage, spanBuffer?)` に optional 引数。後方互換必須 |
| push タイミング | ingest の anomaly filter の **前**（正常スパンも含め全件記録） |
| 集計方式 | オンデマンド（API 呼び出し時に計算）。定期バッチなし |
| health 閾値 | healthy: errorRate < 0.01 かつ p95 < 2000ms / degraded: どちらか超過 / critical: errorRate >= 0.05 または p95 >= 5000ms |
| trend | 直近 6 分を 1 分バケット × 6 で req/s 算出。oldest first |
| 非機能（ADR 0025） | GET /api/services・GET /api/activity はブロッキング IO なし。計算のみで返す |
| 非目標 | 永続化・分散共有・リアルタイム push・外部依存なし |

### Commit

```
docs/adr/0029-ambient-read-model.md
```

**→ 人間が ADR 0029 を確認・承認してから次フェーズへ進む。**

---

## Phase 1: 型定義（順次実行）

Phase 2 の並列エージェント両方が依存する gate ステップ。コミットしてから TeamCreate を起動する。

### Task 1-1: types.ts を作成する

- ファイル: `apps/receiver/src/ambient/types.ts`

定義すべき型（名前・形・必須フィールドを以下に示す。実装者はこの仕様から書くこと）:

**BufferedSpan**
- `ExtractedSpan` から派生
- 追加フィールド: `ingestedAt: number`（Unix ms）

**ServiceSurface**
- `name: string` — service.name
- `health: "healthy" | "degraded" | "critical"`
- `reqPerSec: number` — バッファ内スパンの req/s（直近 TTL 窓で計算）
- `p95Ms: number` — p95 レイテンシ（ms）
- `errorRate: number` — 0.0〜1.0
- `trend: number[]` — 長さ 6 の req/s 配列（1 分バケット、oldest first）

**RecentActivity**
- `ts: number` — startTimeMs
- `service: string`
- `route: string` — httpRoute または空文字
- `httpStatus: number | undefined`
- `durationMs: number`
- `traceId: string`
- `anomalous: boolean`

### Commit

```
feat(ambient): add ambient surface types (ADR 0029)
```

**→ このコミット後に TeamCreate を起動する。**

---

## Phase 2: TeamCreate 並列実装

**起動方法:**

```
TeamCreate({
  agents: [
    { name: "domain", model: "sonnet", tasks: ["Task 2-D1", "Task 2-D2", "Task 2-D3"] },
    { name: "transport", model: "sonnet", tasks: ["Task 2-T1", "Task 2-T2"] },
  ]
})
```

**前提:** Phase 1 の types.ts がコミット済みであること。両エージェントはそこから型をインポートする。

---

### Agent: domain

#### Task 2-D1: SpanBuffer（TDD）

- テストファイル: `apps/receiver/src/__tests__/ambient/span-buffer.test.ts`
- 実装ファイル: `apps/receiver/src/ambient/span-buffer.ts`

**テストを先に書き、fail を確認してから実装する。**

テストに含めるべきケース:
- 初期状態で getAll() は空配列を返す
- push したスパンが getAll() に含まれる
- max 1000 件を超えると oldest が push-out される（ring buffer）
- TTL（5min）を超えたスパンは getAll() に含まれない
- TTL 未満のスパンは含まれる
- push / getAll は `ingestedAt` を基準に TTL を判定する（wall clock ではなく引数で制御できること。テスト容易性のため `now?: number` 引数を受ける設計を推奨）

**Commit ごと:**
```
test(ambient): span-buffer tests (red)
feat(ambient): implement SpanBuffer (green)
```

#### Task 2-D2: service-aggregator（TDD）

- テストファイル: `apps/receiver/src/__tests__/ambient/service-aggregator.test.ts`
- 実装ファイル: `apps/receiver/src/ambient/service-aggregator.ts`

**テストを先に書き、fail を確認してから実装する。**

テストに含めるべきケース:

`computeServices`:
- 空配列 → []
- 単一サービス・正常スパンのみ → health: "healthy"
- errorRate >= 0.01 → health: "degraded"
- errorRate >= 0.05 → health: "critical"
- p95 >= 2000ms → health: "degraded"
- p95 >= 5000ms → health: "critical"
- trend 配列は長さ 6、oldest first
- 複数サービスが混在する場合にサービスごとに集約される

`computeActivity`:
- 空配列 → []
- limit=5 で 10 件スパンがある → 5 件返す（最新順）
- limit は 1〜100 に clamp される（0 → 1, 200 → 100）
- anomalous フラグが isAnomalous() と一致する

**Commit ごと:**
```
test(ambient): service-aggregator tests (red)
feat(ambient): implement service-aggregator (green)
```

#### Task 2-D3: barrel

- ファイル: `apps/receiver/src/ambient/index.ts`
- SpanBuffer / computeServices / computeActivity / 全型を re-export する

```
feat(ambient): add ambient/index.ts barrel
```

---

### Agent: transport

**前提:** types.ts (Phase 1) がコミット済み。domain エージェントの実装は不要（型だけで十分）。

#### Task 2-T1: API ルートの修正（TDD）

- テストファイル: `apps/receiver/src/__tests__/ambient/api-ambient.test.ts`
- 修正ファイル: `apps/receiver/src/transport/api.ts`

**テストを先に書き、fail を確認してから実装する。**

テストに含めるべきケース:
- `createApiRouter(storage)` — spanBuffer なし → GET /api/services が `[]` を返す（500 ではなく 200）
- `createApiRouter(storage)` — spanBuffer なし → GET /api/activity が `[]` を返す（200）
- `createApiRouter(storage, spanBuffer)` — spanBuffer あり → GET /api/services が SpanBuffer のデータを反映する
- `createApiRouter(storage, spanBuffer)` — GET /api/activity?limit=5 → limit が反映される
- `GET /api/activity?limit=0` → limit が 1 に clamp される
- `GET /api/activity?limit=200` → limit が 100 に clamp される
- 既存ルート（GET /api/incidents など）が引き続き動作する

**修正仕様（コード不要。仕様のみ）:**

`createApiRouter` のシグネチャに `spanBuffer?: SpanBuffer` を追加。
`GET /api/services`: spanBuffer が未設定なら `[]` を返す。設定されていれば `computeServices(spanBuffer.getAll(), Date.now())` を返す。
`GET /api/activity?limit=N`: `limit` を `parseInt` して 1〜100 に clamp。未設定・NaN は 20。 spanBuffer が未設定なら `[]`。

**Commit ごと:**
```
test(transport): api-ambient tests (red)
feat(transport): add GET /api/services and GET /api/activity
```

#### Task 2-T2: ingest.ts の修正

- 修正ファイル: `apps/receiver/src/transport/ingest.ts`

`createIngestRouter` のシグネチャに `spanBuffer?: SpanBuffer` を追加。
`POST /v1/traces` の `extractSpans(body)` 直後（`anomalousSpans` の filter より前）で `spanBuffer?.push(...)` を呼ぶ。

既存テスト（`apps/receiver/src/__tests__/transport/otlp-protobuf.test.ts` 等）が引き続き通ることを確認する。

```
feat(transport): push spans to SpanBuffer before anomaly filter
```

---

## Phase 3: 統合 + E2E テスト（順次実行）

**前提:** Phase 2 の両エージェントが完了していること。

### Task 3-1: createApp() に SpanBuffer を注入する

- 修正ファイル: `apps/receiver/src/index.ts`

`createApp()` の先頭で `new SpanBuffer()` を生成し、`createIngestRouter(store, spanBuffer)` と `createApiRouter(store, spanBuffer)` に渡す。

### Task 3-2: E2E テストを書く（TDD）

- テストファイル: `apps/receiver/src/__tests__/ambient/ambient-e2e.test.ts`

**テストを先に書き、fail を確認してから実装する。**

このテストは `createApp()` を使い、real HTTP リクエストでエンドツーエンドを確認する。

テストに含めるべきケース:
- `POST /v1/traces` で正常スパンを送信 → `GET /api/services` に service が含まれる
- `POST /v1/traces` で異常スパンのみ送信 → `GET /api/services` に service が含まれる（異常スパンもバッファされるため）
- `POST /v1/traces` で複数サービスのスパンを送信 → `GET /api/services` に複数 service が含まれる
- `GET /api/activity?limit=3` → 最大 3 件返る
- スパン送信なしの初期状態 → `GET /api/services` = `[]`、`GET /api/activity` = `[]`（500 ではない）

**Commit:**
```
test(ambient): e2e integration test
feat(receiver): wire SpanBuffer into createApp
```

### Task 3-3: 全テストスイートを実行する

```bash
cd apps/receiver && pnpm test
pnpm typecheck
pnpm lint
```

全てグリーンになること。**1 件でも失敗があれば Phase 4 に進まないこと。**

---

## Phase 4: opus 4.6 レビュー

```
Agent: review (model: opus 4.6)
Task: 変更ファイル全体のコードレビューを実施する
```

レビュー観点:
- ADR 0029 の決定内容との整合性
- StorageDriver に変更が入っていないこと（ADR 0013）
- auth ミドルウェア（ADR 0011）: GET /api/services・GET /api/activity が ADR 0028 の「Console SPA (same-origin) — no Bearer required」に従っているか
- 後方互換: `createIngestRouter(storage)` / `createApiRouter(storage)` 呼び出し（spanBuffer なし）で既存テストが通るか
- ADR 0025: GET /api/services・GET /api/activity がブロッキング IO を持っていないか（in-memory 計算のみか）
- ring buffer の push-out ロジックが正しいか（TTL と capacity 両方）
- health 閾値が ADR 0029 と一致しているか
- limit clamp の実装が正しいか（0 → 1, 200 → 100, NaN → 20）
- テストカバレッジが仕様の重要な境界値を網羅しているか
- security: GET /api/services・GET /api/activity の response に機密情報（token, secret, 内部 IP 等）が含まれないか

**ブロッカーが 1 件でもあれば差し戻し。approve のみ次へ進む。**

---

## 完了条件（Complete Criteria）

以下を全て満たすまで「実装完了」と言ってはいけない。

### 機能要件

- [ ] `GET /api/services` → `ServiceSurface[]`（JSON, 200）
- [ ] `GET /api/activity?limit=N` → `RecentActivity[]`（JSON, 200、max 100件）
- [ ] バッファ空状態で両エンドポイントが `[]` を返す（500 ではない）
- [ ] `POST /v1/traces` で送信した全スパン（正常・異常問わず）がバッファに記録される
- [ ] max 1000件超過で oldest が push-out される
- [ ] TTL 5min 超過スパンが `getAll()` から除外される
- [ ] health 閾値（healthy / degraded / critical）が ADR 0029 と一致する
- [ ] trend が 6 点 1 分バケット oldest-first で算出される

### 後方互換性

- [ ] `createIngestRouter(storage)` ← spanBuffer なし → 既存テストが通る
- [ ] `createApiRouter(storage)` ← spanBuffer なし → 既存テストが通る
- [ ] 既存 `GET /api/incidents`、`GET /api/incidents/:id`、`POST /api/diagnosis/:id`、`POST /api/chat/:id` に影響なし

### 品質

- [ ] `pnpm test`（apps/receiver）全件グリーン
- [ ] `pnpm typecheck` エラーなし
- [ ] `pnpm lint` エラーなし
- [ ] ADR 0029 コミット済み・承認済み
- [ ] opus 4.6 レビューでブロッカーなし

### 明示的な非完了条件

以下のいずれかであれば完了とは言えない:

- テストが追加したが happy path のみで境界値（max capacity, TTL boundary, limit clamp, health threshold）を検証していない
- `pnpm test` をローカルで回していない
- StorageDriver に手が入っている
- GET /api/services・GET /api/activity に bearerAuth が掛かっている（ADR 0028 違反）
- opus 4.6 レビューを通過していない

---

## ファイル変更一覧

| 操作 | ファイルパス |
|------|-------------|
| 新規 | `docs/adr/0029-ambient-read-model.md` |
| 新規 | `apps/receiver/src/ambient/types.ts` |
| 新規 | `apps/receiver/src/ambient/span-buffer.ts` |
| 新規 | `apps/receiver/src/ambient/service-aggregator.ts` |
| 新規 | `apps/receiver/src/ambient/index.ts` |
| 新規 | `apps/receiver/src/__tests__/ambient/span-buffer.test.ts` |
| 新規 | `apps/receiver/src/__tests__/ambient/service-aggregator.test.ts` |
| 新規 | `apps/receiver/src/__tests__/ambient/api-ambient.test.ts` |
| 新規 | `apps/receiver/src/__tests__/ambient/ambient-e2e.test.ts` |
| 修正 | `apps/receiver/src/transport/ingest.ts` |
| 修正 | `apps/receiver/src/transport/api.ts` |
| 修正 | `apps/receiver/src/index.ts` |

---

## 実装前の合意ポイント（人間への確認依頼）

このプランを進める前に以下を確認してください:

1. **ADR 0029 の内容に合意できるか** — 特に「in-memory のみ・コールドスタートリセット」を MVP で許容するか
2. **TeamCreate 起動タイミング** — Phase 1（types.ts）コミット後に Claude が TeamCreate を自動起動してよいか、人間が明示的に指示するか
3. **merge 先** — Lane B は `feat/lane-b-ambient-read-model` → `develop` の PR とする（ADR 0010 準拠）

---

## 実行オプション

**Plan complete and saved to `docs/plans/2026-03-12-lane-b-ambient-read-model.md`.**

**実行方法は 2 択:**

**Option 1: Subagent-Driven（このセッション）** — Phase 0 から順に Claude がサブエージェントを逐次ディスパッチし、各ステップ間でレビュー

**Option 2: Parallel Session（別セッション）** — 新セッションを開き `superpowers:executing-plans` を使ってバッチ実行

**どちらで進めますか？**
