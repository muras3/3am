# 3amoncall Validation MVP v0.1

> 目的: 実インシデントの生データがない段階で、3amoncall の診断品質を改善できる検証基盤を作る。

## 1. 検証MVPの位置づけ

これはユーザー向けの導入体験ではなく、開発側の評価基盤である。

- ユーザー向けMVP: `Receiver -> トリガー -> 診断 -> 通知`
- 検証MVP: `再現可能な障害シナリオ -> 実測OTel収集 -> 診断 -> 採点`

狙いは、LLM診断そのものを速く改善できる状態を作ること。  
そのため、最初に必要なのは「本物のOTelっぽい fixture」ではなく、実際に動くアプリから毎回同じ障害を再現して OTel を取得できる仕組み。

## 2. 基本方針

`/Users/murase/project/probe-investigate/docs/reports/2026-03-05-fixture-designs.md` の設計方針をそのまま踏襲する。

- 単一ソースだけでは根本原因が分からない
- traces / logs / metrics / platform-like signals を跨いで相関が必要
- temporal reasoning が必要
- 現実的な red herring を含める

したがって、検証MVPは「JSON fixture を手書きする仕組み」ではなく、以下を備えた障害再現ハーネスにする。

- 小さなテストアプリ
- 障害注入スイッチ
- 負荷生成
- OTel 収集
- 収集結果の fixture 化
- fixture に対する自動診断・自動採点

## 3. テストアプリの要件

最初の1本は、serverless 風の依存関係を持つ小さな HTTP アプリにする。

必要な構成:

- `web` API
  - `POST /checkout`
  - `GET /orders/:id`
  - `GET /health`
  - 将来シナリオ用: `POST /notify`, `GET /products`
- `dependency` 群
  - 外部APIモック（Stripe風）
  - PostgreSQL（red herring生成 + 将来の db_migration シナリオ用）
  - キャッシュ層（将来用、最初は不要）
- OTel 計装
  - traces
  - logs
  - metrics

このアプリは本番品質である必要はない。重要なのは次の3点。

- 障害を何度でも同じように再現できる
- 因果連鎖が 2-4 hop 以上ある
- 正常時との差分を時系列で観測できる

## 4. 推奨アプリ構成

最初の検証用としては、Node.js / TypeScript で十分。理由は以下。

- Vercel / Cloudflare 周辺の開発者に近い
- event loop / timeout / secret rotation / external API failure を再現しやすい
- OTel 計装が容易

推奨構成:

- `apps/demo-web`
  - Express か Next.js API routes 相当の軽量HTTPアプリ
- `apps/mock-deps`
  - Stripe/SendGrid/notification-svc 風のモック依存
- `packages/scenario-runner`
  - 障害注入と負荷実行
- `packages/collector`
  - OTel を受けて JSON fixture に保存

最初から Vercel/Cloudflare 本番デプロイに寄せすぎる必要はない。  
ローカルまたは docker-compose 相当で再現できる方が、診断改善のループは速い。

## 5. 最初に実装する障害シナリオ

最初は 5 本で十分。`2026-03-05-fixture-designs.md` の approved fixture から、3amoncall の価値検証に効くものを優先する。

### A. third_party_api_rate_limit_cascade

理由:

- 小規模プロダクトでも起きやすい
- 外部API起因と内部設計欠陥の区別が必要
- 初動提案の価値が高い

最低限必要な信号:

- 外部API 429
- retry 回数
- worker / concurrency 使用率
- queue depth
- app 全体の 504 増加

### B. db_migration_lock_contention

理由:

- 本番でありがちなわりに、単純なメトリクスでは誤診しやすい
- sudden recovery が因果推定に効く

最低限必要な信号:

- long-running query
- migration 開始ログ
- query latency / timeout
- connection pool 利用率

### C. upstream_cdn_stale_cache_poison

理由:

- serverless / edge 文脈で差別化しやすい
- origin 復旧後も障害継続するパターンは有用

最低限必要な信号:

- origin 5xx 短時間
- CDN cache HIT/MISS
- GET と POST/health の挙動差
- TTL 経過で cliff-drop

### D. secrets_rotation_partial_propagation

理由:

- Vercel 系の現実感がある
- deploy 周辺の red herring を入れやすい

最低限必要な信号:

- 新旧デプロイ識別子
- 外部API 401
- エラー率 plateau-then-decay
- deploy / env 更新イベント

### E. cascading_timeout_downstream_dependency

理由:

- shared capacity collapse を見抜けるか検証できる
- 「遅い依存先」が全体障害に波及する典型例

最低限必要な信号:

- downstream latency
- route 別エラー拡大の時系列
- concurrency saturation
- DB CPU 上昇などの二次症状

## 6. シナリオ実装の粒度

各シナリオは以下の共通構造を持つ。

### 入力

- `scenario.yaml`
  - シナリオID
  - root cause
  - causal chain
  - red herrings
  - expected recovery action
- `fault knobs`
  - latency
  - error rate
  - retry policy
  - cache TTL
  - deploy skew

### 実行

- 正常状態を 5-10 分流す
- 指定時刻で fault injection
- 負荷を継続
- OTel と platform-like events を保存

### 出力

- `traces.json`
- `logs.jsonl`
- `metrics.json`
- `events.json`
- `ground_truth.json`

`ground_truth.json` は probe-investigate の `scenario.schema.json` の `ground_truth` フィールドと互換にする。

注意: probe-investigate スキーマは `additionalProperties: false` なので、拡張フィールドを同一オブジェクトに混ぜると検証に落ちる。そのため検証固有フィールドは `validation_extensions` オブジェクトに隔離する。

前提タスク: probe-investigate 側の `scenario.schema.json` の `ground_truth` に `validation_extensions` を optional フィールドとして追加する。これが完了するまでは検証 fixture は probe-investigate の検証パイプラインに通せない。

正本の定義: ground truth の正本は `ground_truth.template.json` とする。`scenario.yaml` 内の `ground_truth` は参照用サマリのみ置き、詳細は template を参照する。

probe-investigate 互換（必須）:

- `primary_root_cause`
- `contributing_root_causes`
- `detail` (`component`, `trigger_signal`, `failure_mode`)
- `recommended_actions`
- `t_first_symptom_oracle`

`validation_extensions` に格納（検証固有）:

- `trigger` — 外部トリガー（インシデントを引き起こした外部要因。例: flash sale traffic spike）
- `causal_chain` — 因果連鎖のステップ列
- `expected_immediate_action` — 初動で取るべきアクション
- `expected_do_not` — やってはいけないアクション
- `red_herrings` — 意図的に混入した誤誘導

用語の区別:
- `trigger`: インシデントの外部きっかけ（例: "flash sale traffic spike"）
- `detail.trigger_signal`: 最初に観測可能な兆候（例: "Stripe API returning 429 status codes"）

## 7. OTel 以外に保存すべきデータ

OTel だけでは足りない。診断では「運用イベント」も重要なので、fixture には OTel 以外の補助信号も含める。

- deploy event
- env var rotation event
- migration start/finish
- cron start/finish
- synthetic status check results
- CDN purge or no-purge markers

これは本番でも Slack や GitHub Actions の入力として使える形式に近いので、後で Receiver に接続しやすい。

## 8. 採点基準

診断品質の評価は `root cause を言い当てたか` だけでは弱い。MVP向けには次の4軸で採点する。

注: probe-investigate では LLM-as-judge による 10点満点を使用した。ここでは軸ごとの分解能を確保するため 4軸×0-2 の 8点満点に変更する。probe-investigate スコアとの大まかな対応: 7-8 ≈ 8-10, 5-6 ≈ 5-7, 0-4 ≈ 0-4。将来的には 10点スケールに統一し、LLM-as-judge と人間評価の両方で採点する方針。

### 1. 初動有効性

提案された immediate action が、被害を縮小する方向に働くか。

- 0: 無関係または有害
- 1: 部分的に有効
- 2: 有効

### 2. 根本原因の妥当性

trigger と internal design flaw を区別して説明できているか。

- 0: 誤診
- 1: 半分正しい
- 2: ほぼ正しい

### 3. 因果連鎖の整合性

時系列と shared resource collapse を説明できているか。

- 0: 症状列挙のみ
- 1: 部分的に整合
- 2: 整合している

### 4. 危険な誤提案の有無

やってはいけない行動を避けられているか。

- 0: 危険な提案あり
- 1: 軽微なノイズあり
- 2: 問題なし

合計 8 点満点とし、まずは以下を暫定基準にする。

- 7-8: 実用候補
- 5-6: 改善継続
- 0-4: プロンプトまたは入力設計の見直し

## 9. 最小実装順

実装順は以下がよい。

1. `scenario-runner` を作る
2. `third_party_api_rate_limit_cascade` だけ実装する
3. OTel と補助イベントを fixture 化する
4. fixture を診断ランタイムに食わせる
5. 採点を半自動化する
6. その後に残り 4 シナリオを追加する

理由:

- 最初から 5 本同時に作るとデータ品質の失敗原因を切り分けにくい
- rate limit cascade は signals が豊富で、3amoncall の初動提案価値も出やすい

## 10. 検証時のモデル選択

probe-investigate の知見として「モデルの選択はプロンプト以上に診断品質に影響する」ことが判明している（同一 v5 プロンプトで Sonnet 4 avg 7.8 → Sonnet 4.6 avg 9.7）。

検証実行時は以下を守る:

- 複数モデルで同一シナリオを評価する（最低 2 モデル）
- モデル名とバージョンを結果に記録する
- プロンプト改善とモデル変更の効果を分離できるようにする

## 11. この検証MVPで答えるべき問い

この基盤で最初に答えるべき問いは限定する。

- 実測 OTel でも v5 プロンプトは有効か
- red herring がある状況で危険な誤提案をどの程度避けられるか
- 初動提案は再現性ある形で採点できるか
- どの signal が足りないと診断品質が大きく落ちるか

逆に、この段階ではまだ答えなくてよい問いもある（probe-investigate Phase 0 の残課題を含む）。

- 汎用異常検知の精度
- 多言語SDK対応
- 本番クラウドへのデプロイ完成度
- 大規模RAGや長期学習

## 12. 結論

実データがないなら、次に作るべきものは「テスト用アプリ」ではある。  
ただし本質はアプリそのものではなく、approved fixture 設計を実測 OTel に変換する障害再現ハーネスである。

最初の成功条件は次の一文に尽きる。

`1つの実アプリで、1つの障害シナリオを、red herring 付きで何度でも再現し、その都度 OTel fixture と ground truth を生成できること。`
