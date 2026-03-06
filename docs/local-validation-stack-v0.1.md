# Local Validation Stack v0.1

> 目的: 3amoncall の診断品質を改善するために、ローカルコンテナで再現可能な障害シナリオ実行環境を構築する。

## 1. 前提

このスタックは本番デプロイ用ではない。  
狙いは次の 4 点に限定する。

- 同じ障害を何度でも再現できる
- traces / logs / metrics を毎回同じ形式で回収できる
- red herring を混ぜた incident fixture を量産できる
- 診断プロンプトの改善サイクルを高速化できる

そのため、最初の環境は `docker compose` ベースでよい。

## 2. 最初の対象シナリオ

最初の 1 本は `third_party_api_rate_limit_cascade` にする。

理由:

- 小規模サービスでも現実に起きやすい
- 外部API障害と内部実装欠陥の切り分けが必要
- OTel signals を比較的取りやすい
- 初動提案の良し悪しを評価しやすい

## 3. 構成

最小構成は 6 コンテナで足りる。

### 1. `web`

主アプリ。HTTP リクエストを受け、注文処理や通知処理を行う。

責務:

- `POST /checkout`
- `GET /orders/:id`
- `GET /health`
- OTel traces / logs / metrics 出力

実装候補:

- Node.js + TypeScript + Express

### 2. `mock-stripe`

外部依存のモック。通常時は成功、障害注入時は 429 を返す。

責務:

- 通常レスポンス
- rate limit 応答
- レスポンスヘッダに limit 情報を含める

### 3. `loadgen`

継続的にトラフィックを流す。正常状態と障害状態の両方を作る。

責務:

- 平常時トラフィック
- flash sale 的な急増
- シナリオ時刻に合わせた負荷変化

### 4. `otel-collector`

OTel 受信。主アプリから送られた traces / logs / metrics をファイルに吐く。

責務:

- OTLP HTTP/gRPC 受信
- file exporter または debug exporter
- scenario ごとに出力先を切る

### 5. `scenario-runner`

障害注入と実行制御を担当する。

責務:

- シナリオ開始
- `mock-stripe` のレート制限切り替え
- `web` の retry policy 切り替え確認
- 実行終了と fixture 収束待ち

### 6. `artifact-writer`

OTel と補助イベントを fixture 形式に整形する。

責務:

- collector 出力の回収
- `events.json`
- `ground_truth.json`
- 最終 fixture ディレクトリ生成

## 4. 推奨ディレクトリ構成

```text
validation/
  docker-compose.yml
  scenarios/
    third_party_api_rate_limit_cascade/
      scenario.yaml
      ground_truth.template.json
  apps/
    web/
    mock-stripe/
  tools/
    scenario-runner/
    artifact-writer/
  otel/
    collector-config.yaml
  out/
    runs/
      2026-03-06T10-00-00Z-third_party_api_rate_limit_cascade/
        traces.json
        logs.jsonl
        metrics.json
        events.json
        ground_truth.json
```

## 5. `web` の設計

`web` は単純だが、shared resource collapse を起こせるようにする必要がある。

最低限の実装要素:

- `POST /checkout`
  - 注文作成
  - `mock-stripe` に支払い要求
  - 失敗時 retry
- 固定サイズ worker/concurrency pool
  - 例: 同時実行 16
- queue depth metric
- request timeout
- span attributes
  - route
  - dependency name
  - retry_count
  - queue_wait_ms
  - worker_slot_id

ここで重要なのは、429 そのものではなく「retry storm による shared pool 枯渇」を起こせること。

## 6. `mock-stripe` の設計

`mock-stripe` は本物らしさより、状態を正確に切り替えられることが重要。

必要な機能:

- mode `normal`
- mode `rate_limited`
- `X-RateLimit-*` ヘッダ返却
- 応答遅延の注入
- 管理 API
  - `POST /__admin/mode`
  - `GET /__admin/state`

これにより `scenario-runner` が deterministic に障害を開始できる。

## 7. `loadgen` の設計

最初は高度なツールは不要。`k6` か軽量な Node スクリプトで十分。

要件:

- 平常時 5-10 RPS
- flash sale 時 50-100 RPS
- 成功率、レイテンシ、HTTP ステータスを出力

重要なのは、一定の traffic burst を毎回同じ形で再現すること。

## 8. `otel-collector` の設計

collector は最小構成でよい。

受信:

- OTLP/HTTP
- OTLP/gRPC

出力:

- traces: JSON file
- logs: JSONL file
- metrics: JSON summary or periodic export

最初から可観測性基盤を作り込まない。  
検証で欲しいのは「診断入力を保存できること」であって、Grafana を整えることではない。

## 9. `scenario-runner` の責務

シナリオ実行のオーケストレータとして、以下を順序制御する。

1. 全コンテナ起動
2. 正常状態 warm-up
3. baseline traffic 開始
4. flash sale 開始
5. `mock-stripe` を rate-limited に変更
6. 一定時間継続
7. シナリオ終了
8. artifact-writer を起動

出力する補助イベント:

- flash sale start
- mock-stripe mode changed
- scenario end
- collector flush started/finished

このイベント列は `events.json` に残す。

## 10. fixture 出力フォーマット

各 run ごとに 1 ディレクトリを作る。

```text
out/runs/<timestamp>-third_party_api_rate_limit_cascade/
  traces.json
  logs.jsonl
  metrics.json
  events.json
  ground_truth.json
  summary.json
```

`summary.json` には LLM に渡す前の incident 概要を入れる。

最低限:

- incident window
- impacted routes
- top errors
- metric deltas
- suspicious dependencies

この summary は将来の Receiver の incident packaging に近い役割を持つ。

## 11. 最小の `ground_truth.json`

```json
{
  "scenario_id": "third_party_api_rate_limit_cascade",
  "trigger": "flash sale traffic spike",
  "root_cause": "fixed-interval retry policy against rate-limited payment dependency exhausted shared worker pool",
  "causal_chain": [
    "traffic spike increases checkout requests",
    "payment dependency starts returning 429",
    "web retries at fixed interval without backoff",
    "shared worker pool saturates",
    "queue depth increases",
    "all orchestrated routes start timing out"
  ],
  "expected_immediate_action": [
    "disable or reduce retries",
    "apply backoff or circuit break payment calls",
    "shed non-critical checkout-related work"
  ],
  "expected_do_not": [
    "restart database",
    "roll back unrelated deploy",
    "scale DB before confirming bottleneck"
  ],
  "red_herrings": [
    "recent deploy unrelated to worker pool behavior",
    "elevated DB connections without DB latency degradation"
  ]
}
```

## 12. まず実装しなくてよいもの

以下は後回しでよい。

- Vercel / Cloudflare 本番デプロイ
- 本物の Stripe API 接続
- 複数ノード構成
- 高度な anomaly detection
- UI
- Slack 通知

## 13. 実装順

1. `docker-compose.yml`
2. `web`
3. `mock-stripe`
4. `otel-collector`
5. `loadgen`
6. `scenario-runner`
7. `artifact-writer`
8. `summary.json` 生成

ここまでで、1シナリオの再現と fixture 生成ができる。

## 14. 完了条件

このローカル検証環境の最初の done は次の状態。

- `docker compose up` で一式起動する
- コマンド 1 つで `third_party_api_rate_limit_cascade` を実行できる
- 実行ごとに fixture ディレクトリが生成される
- LLM 診断に必要な traces / logs / metrics / events / ground truth が揃う
- 同じシナリオを複数回回して大きくぶれない

## 15. 次の段階

1 本目が安定したら、次は `db_migration_lock_contention` を追加する。  
この 2 本が揃うと、外部依存起因と内部DB運用起因の両方を見られるので、診断プロンプトの改善に十分使える。
