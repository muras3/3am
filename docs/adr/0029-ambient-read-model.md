# ADR 0029: Ambient Read Model (SpanBuffer + ServiceSurface / RecentActivity)

- Status: Accepted
- Date: 2026-03-12

## Context

Console の normal mode（ambient surface）は `ServiceSurface[]` と `RecentActivity[]` を必要とする。
現在の receiver は incident canonical store のみを持ち、ambient surface 用の live read model がない。

incident store だけから normal mode を擬似的に構築すると、open incidents がない状態では表示が空になり、
product definition（サービス健全性をリアルタイムに見せる）と合わない。

本 ADR は UI fit-gap analysis（`docs/design/ui-fit-gap-and-implementation-plan-2026-03-12.md`）の
Lane B Phase 3 として位置づけられ、ambient surface に必要な最小限の read model を定義する。

## Decision

### 1. ストレージ方針

in-memory のみ。StorageDriver（ADR 0013）には変更を加えない。

- SpanBuffer はプロセスメモリ上に保持する
- コールドスタート（プロセス再起動）でリセットされる
- best-effort ambient として許容する

### 2. SpanBuffer 仕様

配置: `apps/receiver/src/ambient/` 以下に新規モジュールとして追加。

| 項目 | 仕様 |
|------|------|
| 容量 | max 1000 spans（ring buffer）。capacity 超過時は oldest を push-out |
| TTL | 5 分（300,000 ms）。`getAll()` 呼び出し時に TTL 超過スパンを除外する |
| push タイミング | `POST /v1/traces` ingest の `extractSpans()` 直後かつ anomaly filter（`isAnomalous()`）より前。正常スパンも含め全件記録する |

### 3. 注入方式（後方互換必須）

```typescript
createIngestRouter(storage: StorageDriver, spanBuffer?: SpanBuffer): Hono
createApiRouter(storage: StorageDriver, spanBuffer?: SpanBuffer): Hono
```

- `createApp()` 内で `new SpanBuffer()` を生成し、両ルーターに渡す
- `spanBuffer` が渡されない場合（既存呼び出し）は従来通り動作する（optional 引数）

### 4. 集計方式

オンデマンド計算（API リクエスト時にバッファから計算）。定期バッチ・タイマーなし。

### 5. 型定義

`apps/receiver/src/ambient/types.ts` に配置する。

**BufferedSpan**
```typescript
// ExtractedSpan の全フィールド + ingestedAt
{
  ...ExtractedSpan,
  ingestedAt: number  // Unix ms
}
```

**ServiceSurface**
```typescript
{
  name: string
  health: "healthy" | "degraded" | "critical"
  reqPerSec: number
  p95Ms: number
  errorRate: number
  trend: number[]  // 長さ 6。各バケットの req/s（oldest first）
}
```

**RecentActivity**
```typescript
{
  ts: number              // Unix ms
  service: string
  route: string           // httpRoute。HTTP span 以外は空文字
  httpStatus?: number     // HTTP span 以外は undefined
  durationMs: number
  traceId: string
  anomalous: boolean
}
```

`RecentActivity` は HTTP span に限定しない。`GET /api/activity` は latest-first（`ts` 降順）で返す。

### 6. health 閾値

条件は排他的ではなく、以下の優先順で判定する（上位が一致したら以下の条件は評価しない）。

| health | 条件 |
|--------|------|
| `critical` | `errorRate >= 0.05` OR `p95Ms >= 5000` |
| `degraded` | `errorRate >= 0.01` OR `p95Ms >= 2000` |
| `healthy` | それ以外 |

### 7. trend 計算

- 直近 6 分を 1 分バケット × 6 に分割（oldest first）
- 各バケットの req/s = バケット内スパン数 / 60

### 8. エンドポイント

**GET /api/services**

- レスポンス: `ServiceSurface[]`（HTTP 200, JSON）
- auth: ADR 0028 準拠 — Console SPA same-origin のため Bearer 不要
- **ソート順**: health severity 降順（critical → degraded → healthy）、同一 health 内は reqPerSec 降順、同一 reqPerSec は name 昇順。決定的（deterministic）な順序を保証する

**GET /api/activity?limit=N**

- レスポンス: `RecentActivity[]`（HTTP 200, JSON）
- `limit` は 1〜100 に clamp。未指定・NaN → 20

### 9. 明示的な非目標

- 永続化
- 分散共有（複数インスタンス間の同期）
- リアルタイム push（WebSocket 等）
- Phase 1 での複雑な最適化

## Rationale

- **ADR 0025（responsiveness-first）**: `/api/services` および `/api/activity` はブロッキング IO なし、in-memory 計算のみ。
- **ADR 0013**: StorageDriver は incident canonical store の責務に限定する。ambient read model を混在させない。
- best-effort ambient は MVP として十分。cold-start リセットはサーバーレス環境では許容範囲内。
- オンデマンド集計は実装がシンプルで、過負荷リスクも低い（バッファは max 1000 件）。

## Consequences

- Receiver 再起動（またはサーバーレスの cold start）でバッファがリセットされる。これは設計上の選択であり、best-effort ambient として受け入れ済み。
- Vercel/CF のサーバーレスではインスタンスごとに独立したバッファを持つ。分散集計は非目標。
- SpanBuffer は StorageDriver と異なり、テスト用 mock 化は不要（pure in-memory なのでテストでそのまま使える）。
- optional 引数による注入で、既存の `createIngestRouter` / `createApiRouter` 呼び出し元は変更不要。

## Related

- [0013-cross-platform-storage-driver.md](0013-cross-platform-storage-driver.md)
- [0025-phase1-performance-and-responsiveness-guardrails.md](0025-phase1-performance-and-responsiveness-guardrails.md)
- [0028-receiver-serves-console.md](0028-receiver-serves-console.md)
- [docs/design/ui-fit-gap-and-implementation-plan-2026-03-12.md](../design/ui-fit-gap-and-implementation-plan-2026-03-12.md)

## Amendment (2026-03-17)

[ADR 0032](0032-telemetry-store-and-evidence-selection.md) により、SpanBuffer のスコープを明確化:

- SpanBuffer は **ambient read model の L1 in-memory cache** として維持。仕様 (容量、TTL、push タイミング、集計方式) に変更なし
- 「永続化は非目標」(Decision 9) は SpanBuffer に限定した記述。OTel 生データの永続化は TelemetryStore (ADR 0032) が担う
- TelemetryStore は SpanBuffer と並行して ingest path から書き込まれる L2 persistent store
