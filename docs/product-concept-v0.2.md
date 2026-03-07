# 3amoncall — プロダクト構想 v0.2

> 午前3時のオンコール。障害アラートで叩き起こされたエンジニアが、5分以内に原因を特定し、正しい初動を取れるようにする。

## 1. 何を解決するか

サーバーレスプラットフォーム（Vercel, Cloudflare Workers）にデプロイする個人〜小規模チームは、障害発生時に以下の問題を抱える：

- **Datadog/PagerDutyは高すぎる** — 月額数万〜数十万円。個人開発やスタートアップには現実的でない
- **OTelデータはあるが読めない** — Vercel/CloudflareはOTel対応済みだが、大量のtraces/logs/metricsを人間が読み解くのは3amには無理
- **HolmesGPTはK8s前提** — CNCFの代表的OSSだが、kubectl/Prometheus中心。サーバーレスには刺さらない

**主問題は初動診断の遅さ**。OTelシグナルは存在するが、それを5分以内に根本原因と初動アクションに変換する手段がない。

> *ナレッジ属人化（同じ障害を繰り返す問題）は関連する課題だが、v0.1では主問題に含めていた。v0.2以降はPhase 3のコンテキスト蓄積機能の動機として位置づける。*

## 2. プロダクトの概要

**OTelデータをLLMに食わせて、5分以内にインシデントの根本原因と初動アクションを出す。**

### コア価値: 初動診断

プロダクトの検証済みコア価値は **LLM診断** である。OTel traces/logs/metrics を受け取り、7ステップのSRE調査プロンプト（v5）で根本原因と復旧アクションを出力する。この部分は合成データ・実コンテナ両方で検証済み。

### 機能一覧

1. **LLM診断**: 7ステップのSRE調査プロンプト（v5）で根本原因を特定（検証済み）
2. **初動提案**: 原因に対応した具体的な復旧アクション（検証済み）
3. **Incident Console**: Datadog / New Relic 風の incident-scoped UI で traces / logs / metrics を確認
4. **異常検知**: OTelデータのベースラインからの逸脱を検出（**仮説段階 — 後述**）
5. **コンテキスト蓄積**: Runbook/サービス構造/過去インシデントを診断に注入（Phase 3）

### 検証済みの精度

評価基準: **4軸 × 2点 = 8点満点**（初動有効性 / 根本原因の妥当性 / 因果連鎖の整合性 / 危険な誤提案の有無）

**合成データ（probe-investigate）**

- 10種類のインシデントシナリオで平均 **9.7/10**（8点満点換算）
- 全シナリオ 8/10以上（完全な失敗ゼロ）
- 平均診断時間: **143秒**（5分SLA以内）
- 対象: env設定ミス、イベントループブロック、カスケードタイムアウト、DNS/TLS期限切れ、メモリリーク、シークレットローテーション、DBマイグレーションロック、サードパーティAPIレート制限、キャッシュスタンピード、CDNキャッシュ汚染

**実コンテナ OTel データ（2026-03-07）**

- Docker Compose スタックで 5 シナリオを実行、raw OTel inputs（otel_traces.json / otel_logs.json / otel_metrics.json / platform_logs.json）のみで診断
- Sonnet 4.6 平均 **7.4/8（≈9.2/10）**（フルスケール run）
- 全シナリオ完走: rate_limit_cascade・cascading_timeout・secrets_rotation・cdn_stale_cache 各 8/8、db_migration 5/8
- db_migration の 5/8 は ground_truth の key_discriminator が OTel 非観測データ（pg_stat_activity）に依存していたことが原因。LLM の診断自体は OTel 観測可能な正しい root cause に到達しており、ground_truth を修正済み。

## 3. ターゲットユーザー

| 属性 | 詳細 |
|------|------|
| プラットフォーム | Vercel, Cloudflare Workers/Pages |
| チーム規模 | 個人〜10人程度 |
| 技術レベル | OTelの基本は理解しているが、SRE専任はいない |
| 課題 | 障害対応に時間がかかる（初動判断が遅い） |
| 予算 | Datadogに月額数万円は出せない |

## 4. アーキテクチャ

### 全体フロー

```
App (OTel SDK) → Receiver (異常検知 + incident packet生成) → webhook → 診断ランタイム (LLM診断) → Slack通知
```

### コンポーネント

#### Receiver（セルフホスト）
- ユーザーのVercel/Cloudflare上にDeploy Buttonでデプロイ
- OTel受信 + 短期バッファ + 異常検知 + **incident packet生成**
- **Incident Console を提供**: 診断対象の traces / logs / metrics を incident 単位で表示
- **LLM APIキー不要**（軽量・安全）
- 異常検知時にwebhookを発火

Receiver は Datadog や New Relic のような UI を参考にするが、目指すのは汎用 observability 基盤ではない。役割は **3am のインシデント調査に必要な範囲だけを見せる軽量 console** である。

### Incident Console のスコープ

- 対象データは `OTel traces / OTel logs / OTel metrics / platform logs` に限定
- 全文検索型の汎用ログ基盤は作らない
- UI は incident-scoped とし、診断対象の時間窓と関連 signal に絞る
- 保存期間は **最大 3 日** を上限とし、長期保存は前提にしない
- Slack 通知から直接飛んで「なぜその診断になったか」を確認できることを重視する

つまり Receiver は「mini Datadog」ではなく、**診断結果の根拠を検証するための短期観測 inbox** として設計する。

### Incident Packet の役割

Receiver は ingest した raw observability data をそのまま LLM に渡さない。  
代わりに、incident-scoped な `incident packet` を生成して診断ランタイムへ渡す。

packet に含めるもの:

- incident window
- changed metrics の要約
- representative traces / spans
- relevant logs clusters
- deployment / config / dependency mode などの補助イベント
- Incident Console から参照する evidence pointer

これは LLM 不要の前処理であり、`retrieval / correlation / packaging` の層として Receiver が担う。

### Problem Grouping と Packetization

Receiver は複数の signal / alert をそのまま個別通知しない。  
同じ incident に属すると判断できるものは、まず **1つの problem** に束ねてから packet を作る。

LLM を使わずに行うこと:

- time window の切り出し
- service / route / deployment / dependency の scope narrowing
- related alerts の problem grouping
- changed metrics の抽出
- representative traces / spans / logs の選定

LLM（v5）が担当するのは、その packet を読んだ後の

- trigger の解釈
- root cause の特定
- causal chain の説明
- recovery action の提案

である。

#### 診断ランタイム（実行環境は未確定）

Receiverからwebhookと `incident packet` を受け取り、v5プロンプトでLLM診断を実行する。実行環境の選択肢は以下のとおりで、v0.2時点では確定していない：

| 環境 | メリット | デメリット |
|------|----------|------------|
| GitHub Actions | LLMキーをSecrets管理、無料枠あり | GitHub依存、Vercel/CFユーザー全員が使うわけではない |
| ローカルCLI | packet schema や replay 検証に向く | 本番導線の中核にはなりにくい |
| Vercel Functions / CF Workers | プラットフォームと統一 | LLMキーの置き場所が問題 |

MVP では GitHub Actions を**推奨構成の1つ**として提供しつつ、他環境への対応を順次検討する。  
ただし、packet 生成の本体は Receiver 側に置き、CLI は validation / replay 用に限定する。

### クレデンシャル分離の設計意図

```
Receiver (Vercel env vars)      → OTelエンドポイントのみ。LLMキー不要
GitHub Actions (GitHub Secrets) → LLM APIキーをここに。心理的抵抗が低い
ローカルCLI                      → 開発者のローカル環境。最も抵抗が低い
```

ユーザーにとって「ReceiverにClaude APIキーを置く」のは心理的抵抗が大きい。GitHub Secretsやローカル環境なら、多くの開発者が抵抗なくAPIキーを管理できる。

## 5. 技術的決定事項

### OTel計装
- **probe独自SDKは作らない** — 既存OTel SDK（`@vercel/otel`等）をそのまま使う
- **OTel準拠を維持した helper を提供**: `console.log` → OTel Logs 変換や、診断に重要な attribute の付与を薄く補助
- セットアップガイドで計装方法を案内
- Receiver の Incident Console も、この OTel + platform logs を正本データとして使う
- 目標は独自データモデルではなく、**OTel-native な diagnosis-ready instrumentation** である

### 異常検知

**Phase 1: OTel-native ルールベース（確定）**

業務ロジックに依存しない OTel 標準フィールドのみを使い、以下のシグナルを検知する：

| シグナル | 検知条件 |
|---------|---------|
| `span.status = ERROR` | 発生率が閾値を超えた場合 |
| `http.response.status_code >= 500` | 割合が閾値を超えた場合 |
| `http.response.status_code = 429` | 発生（外部依存のレート制限）|
| span duration | 固定閾値超え（絶対値 or 直近ベースライン比）|
| span exception event | 多発した場合 |

利点: 実装シンプル、計装コスト最小、偽陽性率の見積もりが立てやすい。

**Phase 2 以降: 適応型（Dynatrace 的）**

Phase 1 の偽陽性テスト結果を見てから、ベースライン自動学習 + 統計的逸脱検出を検討する。

### LLMモデル
- **ユーザー選択制** — モデルを固定しない
- 検証済み: Claude Sonnet 4.6（avg 9.0/10 相当）
- 他モデル（GPT, Gemini等）も選択可能にする

### コンテキスト蓄積（Phase 3）
- **ベクトルDB/RAGは使わない**（incident.ioの撤退、PagerDutyの"Context Over Cleverness"方針を参照）
- 採用パターン:
  1. **Runbook YAML注入**（HolmesGPT式）
  2. **サービス構造YAML**（PagerDuty式）
  3. **過去インシデント署名マッチ**

### 診断プロンプト（v5 — 7ステップ）
`v5` は raw dump 全体を読むためのプロンプトではなく、problem grouping と packetization を経た `incident packet` を読むための推論レイヤーとして使う。

1. **Triage**: 重要度・影響範囲の初期判定
2. **Quantify Changes**: 各次元を0-100でスコアリング（0も有益な情報）
3. **Map Dependencies and Shared Resources**: 内部/外部の依存関係を仮説より先にマッピング
4. **Trace Error Responses**: エラーそのものではなく、システムの「反応」を追跡
5. **Form and Test Hypotheses**: カスケード認識、「トレンド≠原因」の原則
6. **Determine Recovery Action**: 原因と一致する復旧アクションを提案
7. **Verify Reasoning**: 反事実テスト + 制御可能性テスト（原因が外部なら内部の設計欠陥を探す）

### 出力スキーマ
```json
{
  "investigation_log": {
    "triage": "...",
    "change_scores": {},
    "shared_resources": [],
    "error_responses": [],
    "hypotheses": [],
    "counterfactual": "..."
  },
  "severity": "critical|high|medium|low",
  "impact_scope": "...",
  "recovery_action": {
    "immediate": "...",
    "follow_up": "...",
    "do_not": "..."
  },
  "trigger": "外部トリガー",
  "root_cause": "内部設計欠陥",
  "causal_chain": ["event1 → event2 → ..."]
}
```

## 6. 差別化

| 軸 | 3amoncall | HolmesGPT | Datadog Bits AI |
|-----|-----------|-----------|-----------------|
| 対象 | サーバーレス (Vercel/CF) | K8s | 全般 |
| 価格 | OSS（無料） | OSS（無料） | 高額 |
| データ | OTelネイティブ | kubectl/Prometheus | プラットフォーム内蔵 |
| セットアップ | Deploy Button + OTel | Helm chart | SaaS契約 |
| ターゲット | 個人〜小規模チーム | K8s運用チーム | エンタープライズ |

**ポジション**: HolmesGPTがK8s世界のOSS診断ツールなら、3amoncallはサーバーレス世界のOSS診断ツール。

**タイミングの追い風**: Vercel・Cloudflare Workers がいずれも OTel を標準的に取り込む方向に動いており、OTelシグナルの収集コストが下がりつつある。今がサーバーレス特化の診断ツールを作るタイミングとして適切。

## 7. リスク

未解決タスクの一覧ではなく、**プロダクトの成立を脅かすリスク**として整理する。

| 重大度 | リスク | 現状 | 対策仮説 |
|--------|--------|------|----------|
| **CRITICAL** | 偽陽性率が高く使い物にならない | 未測定。正常系シナリオでのテスト未実施 | 許容基準を先に定義してから実装 |
| **CRITICAL** | OTel計装コストが実際には高い | 「一発入れときゃOK」の定義が未設計。追加計装・incident packaging が必要な可能性大 | MVP前にVercel実アプリで計装コストを実測する |
| **HIGH** | 異常検知アルゴリズムが未確立 | ルールベース vs 統計的閾値の第一仮説のみ | ルールベースをMVP第一仮説とし、偽陽性テストで検証 |
| ~~**HIGH**~~ | ~~FAST_MODE結果の留保~~ | フルスケール run 完了（avg 7.4/8 ≈ 9.2/10）。FAST_MODE との差は 0.2pt 以内で実用上問題なし | **解消済み** |
| **MEDIUM** | LLMコスト爆発 | 1インシデントあたりのトークン消費量未見積もり。大量アラート時のコスト不明 | トークン計測をvalidation harness に追加する |
| **MEDIUM** | incident packet 生成が弱く、LLM input が肥大化する | フルスケール run では raw data が数 MB 規模になる | packet 生成を Receiver に置き、scope narrowing と signal extraction を前段で行う |
| **MEDIUM** | problem grouping が弱く、1障害が複数通知に分裂する | Datadog/Dynatrace のような problem 化は未実装 | related alerts を LLM なしで problem 単位に束ねる前段ロジックを実装する |
| **MEDIUM** | 診断ランタイムの実行環境が未確定 | GitHub Actions推奨だが、全ユーザーが使うわけではない | MVP時点は選択式にしてユーザー行動を観察する |
| **MEDIUM** | Receiver がログ基盤化して複雑化する | Incident Console を広げすぎると mini Datadog になり、検索・保持・権限管理が重くなる | OTel + platform logs 限定、incident-scoped、最大3日保持を設計原則に固定する |
| **LOW** | 配布・採用戦略未検討 | Phase 2以降 | 未着手 |

## 8. Phase 1 開始条件

Phase 1（MVP実装）に進んでよい条件を以下に定義する。条件を満たさずに実装を開始しない。

- [x] **異常検知第一仮説の確定**: OTel-native ルールベース（span.status/http.status_code/duration/exception）で確定
- [x] **フルスケールrunでの再検証**: FAST_MODE ではなく本来の所要時間（warmup込み13分/シナリオ）で 5 シナリオを実行し、9.0/10相当の精度を確認する（完了: avg 7.4/8 ≈ 9.2/10）

※ 偽陽性基準の定義は実プロダクト実装後に測定するのが合理的なため Phase 1 内タスクへ移動

## 9. ロードマップ

### Phase 0: 検証（現在）
- [x] 診断精度の検証（10 fixtures 合成データ, avg 9.7/10）
- [x] プロンプト設計（v5, 7ステップ）
- [x] 競合・コンテキスト蓄積アーキテクチャ調査
- [x] 実コンテナ OTel データでの検証（5 シナリオ, avg 9.0/10 相当 / FAST_MODE）
- [x] フルスケールrunでの再検証（完了: avg 7.4/8 ≈ 9.2/10）
- [x] 異常検知第一仮説の確定（OTel-native ルールベースで確定）

### Phase 1: MVP
- [ ] 技術スタック決定（Rust/Go/TS）
- [ ] CLIプロトタイプ（OTelファイル → v5診断 → 結果出力）
- [ ] Receiverプロトタイプ（OTel受信 + 異常検知 + webhook）
- [ ] Incident Consoleプロトタイプ（incident-scoped traces / logs / metrics 表示, 最大3日保持）
- [ ] GitHub Actions連携（推奨構成の1つとして）
- [ ] 偽陽性テスト（正常系シナリオで偽陽性率を測定し許容基準を定義）

### Phase 2: OSS公開
- [ ] リポジトリ整備（README, LICENSE, CONTRIBUTING）
- [ ] Deploy Button（Vercel / Cloudflare）
- [ ] セットアップガイド
- [ ] サンプルアプリケーション

### Phase 3: コンテキスト蓄積
- [ ] Runbook YAML
- [ ] サービス構造YAML
- [ ] 過去インシデント署名マッチ
- [ ] ベースライン学習

---

*v0.1 からの主な変更: 主問題を初動診断の遅さに絞った / 異常検知を「仮説段階」として分離 / 検証エビデンスに評価基準とFAST_MODE留保を明記 / リスク章を重大度つきに再構成 / Phase 1 開始条件を定義*

*検証データ・スコア詳細はprobe-investigateリポジトリ、validation harnessはvalidation/を参照。*
