# 3am — プロダクト構想 v0.1

> 午前3時のオンコール。障害アラートで叩き起こされたエンジニアが、5分以内に原因を特定し、正しい初動を取れるようにする。

## 1. 何を解決するか

サーバーレスプラットフォーム（Vercel, Cloudflare Workers）にデプロイする個人〜小規模チームは、障害発生時に以下の問題を抱える：

- **Datadog/PagerDutyは高すぎる** — 月額数万〜数十万円。個人開発やスタートアップには現実的でない
- **OTelデータはあるが読めない** — Vercel/CloudflareはOTel対応済みだが、大量のtraces/logs/metricsを人間が読み解くのは3amには無理
- **HolmesGPTはK8s前提** — CNCFの代表的OSSだが、kubectl/Prometheus中心。サーバーレスには刺さらない
- **障害対応のナレッジが属人化** — 同じ障害を何度も1から調査してしまう

## 2. プロダクトの概要

**OTelデータをLLMに食わせて、5分以内にインシデントの根本原因と初動アクションを出す。**

### コア機能
1. **異常検知**: OTelデータのベースラインからの逸脱を検出（LLM不使用）
2. **LLM診断**: 7ステップのSRE調査プロンプト（v5）で根本原因を特定
3. **初動提案**: 原因に対応した具体的な復旧アクション
4. **コンテキスト蓄積**: Runbook/サービス構造/過去インシデントを診断に注入

### 検証済みの精度
- 10種類のインシデントシナリオ（合成データ）で平均 **9.7/10**（probe-investigate）
- 全シナリオ 8/10以上（完全な失敗ゼロ）
- 平均診断時間: **143秒**（5分SLA以内）
- テスト対象: env設定ミス、イベントループブロック、カスケードタイムアウト、DNS/TLS期限切れ、メモリリーク、シークレットローテーション、DBマイグレーションロック、サードパーティAPIレート制限、キャッシュスタンピード、CDNキャッシュ汚染

### 実コンテナ OTel データでの検証（2026-03-07）
- コンテナスタックで 5 シナリオを実行、raw OTel inputs のみで診断（summary.json 不使用）
- Sonnet 4.6 平均 **7.2/8（≈9.0/10）**
- 強い診断: rate_limit_cascade・cascading_timeout・secrets_rotation（各 8/8）
- 要改善: db_migration（lock chain の 3 段階構造）、cdn_stale_cache（Cache-Control 設定欠陥の root cause 特定）
- FAST_MODE（信号量少）での評価のため、フルスケール run での再検証が必要

## 3. ターゲットユーザー

| 属性 | 詳細 |
|------|------|
| プラットフォーム | Vercel, Cloudflare Workers/Pages |
| チーム規模 | 個人〜10人程度 |
| 技術レベル | OTelの基本は理解しているが、SRE専任はいない |
| 課題 | 障害対応に時間がかかる、ナレッジが蓄積されない |
| 予算 | Datadogに月額数万円は出せない |

## 4. アーキテクチャ

### 全体フロー

```
App (OTel SDK) → Receiver (異常検知) → webhook → GitHub Actions / CLI (LLM診断) → Slack通知
```

### コンポーネント

#### Receiver（セルフホスト）
- ユーザーのVercel/Cloudflare上にDeploy Buttonでデプロイ
- OTel受信 + バッファ + 異常検知
- **LLM APIキー不要**（軽量・安全）
- 異常検知時にwebhookを発火

#### 診断ランタイム（GitHub Actions推奨 / ローカルCLI）
- Receiverからwebhookを受けてOTelデータを取得
- v5プロンプトでLLM診断を実行
- LLM APIキーはここで管理（GitHub Secrets or ローカル）
- 結果をSlack/Discord等に通知

### クレデンシャル分離の設計意図

```
Receiver (Vercel env vars)     → OTelエンドポイントのみ。LLMキー不要
GitHub Actions (GitHub Secrets) → LLM APIキーをここに。心理的抵抗が低い
ローカルCLI                     → 開発者のローカル環境。最も抵抗が低い
```

ユーザーにとって「ReceiverにClaude APIキーを置く」のは心理的抵抗が大きい。GitHub Secretsやローカル環境なら、多くの開発者が抵抗なくAPIキーを管理できる。

## 5. 技術的決定事項

### OTel計装
- **probe独自SDKは作らない** — 既存OTel SDK（`@vercel/otel`等）をそのまま使う
- **薄いブリッジのみ提供**: `console.log` → OTel Logsへの変換
- セットアップガイドで計装方法を案内

### LLMモデル
- **ユーザー選択制** — モデルを固定しない
- 検証済み: Claude Sonnet 4.6（avg 9.7/10）
- 他モデル（GPT, Gemini等）も選択可能にする

### コンテキスト蓄積
- **ベクトルDB/RAGは使わない**
  - incident.ioがベクトル検索から撤退した理由: デバッグ不能、曖昧マッチ、バージョニング問題
  - PagerDutyの方針: "Context Over Cleverness" — 構造化メモリ > embedding
- **代わりに採用するパターン**:
  1. **Runbook YAML注入**（HolmesGPT式）: 正規表現でアラートマッチ → 調査指示をプロンプトに注入
  2. **サービス構造YAML**（PagerDuty式）: 依存関係、デプロイパターン、信頼できるダッシュボード
  3. **過去インシデント署名マッチ**：タイムスタンプ/UUIDを除去した正規化シグネチャで類似インシデント検索

### 診断プロンプト（v5 — 7ステップ）
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

| 軸 | 3am | HolmesGPT | Datadog Bits AI |
|-----|-----------|-----------|-----------------|
| 対象 | サーバーレス (Vercel/CF) | K8s | 全般 |
| 価格 | OSS（無料） | OSS（無料） | 高額 |
| データ | OTelネイティブ | kubectl/Prometheus | プラットフォーム内蔵 |
| セットアップ | Deploy Button + OTel | Helm chart | SaaS契約 |
| ターゲット | 個人〜小規模チーム | K8s運用チーム | エンタープライズ |

**ポジション**: HolmesGPTがK8s世界のOSS診断ツールなら、3amはサーバーレス世界のOSS診断ツール。

## 7. 未解決課題

| 優先度 | 課題 | 状態 |
|--------|------|------|
| HIGH | 技術スタック選定（Rust/Go/TS） | 未決定 |
| HIGH | 偽陽性テスト（正常時に誤検知しないか） | 未テスト |
| HIGH | 実インシデントでの検証（合成データのみで検証済み） | 未テスト |
| MEDIUM | OTel計装の「一発入れときゃOK」体験の定義 | 未設計 |
| MEDIUM | コンテキスト蓄積の実装設計 | 方針決定済み、実装未着手 |
| LOW | 配布・採用戦略 | 未検討 |

## 8. ロードマップ

### Phase 0: 検証（現在 — probe-investigate + validation harness）
- [x] 診断精度の検証（10 fixtures 合成データ, avg 9.7/10）
- [x] プロンプト設計（v5, 7ステップ）
- [x] 競合・コンテキスト蓄積アーキテクチャ調査
- [x] 実コンテナ OTel データでの検証（5 シナリオ, avg 9.0/10 相当）
- [ ] フルスケール run での再検証（FAST_MODE の信号量不足を補う）
- [ ] 偽陽性テスト
- [ ] 実インシデント検証

### Phase 1: MVP
- [ ] 技術スタック決定
- [ ] CLIプロトタイプ（OTelファイル → v5診断 → 結果出力）
- [ ] Receiverプロトタイプ（OTel受信 + 異常検知 + webhook）
- [ ] GitHub Actions連携

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

*このドキュメントはprobe-investigateプロジェクトでの検証結果に基づく。検証データ・スコア詳細はprobe-investigateリポジトリを参照。*
