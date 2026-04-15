<p align="center">
  <a href="https://github.com/muras3/3am">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logo-horizontal-dark.svg"/>
      <img src="assets/logo-horizontal.svg" alt="3am" height="72"/>
    </picture>
  </a>
</p>

<p align="center">サーバーレスアプリのためのインシデント診断ツール</p>

<p align="center">
  <a href="https://github.com/muras3/3am/actions/workflows/ci.yml"><img src="https://github.com/muras3/3am/actions/workflows/ci.yml/badge.svg?branch=develop" alt="CI"/></a>
  <a href="https://www.npmjs.com/package/3am-cli"><img src="https://img.shields.io/npm/v/3am-cli.svg" alt="npm"/></a>
  <a href="#license"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License"/></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>日本語</strong>
</p>

---

OTel データを入れると、診断とアクションプランが出てくる。しきい値もランブックも不要。60 秒以内。

```
ROOT CAUSE HYPOTHESIS
  Checkout-orchestrator retries payment 429s at fixed 100ms intervals
  without backoff → saturates the 16-worker pool → 504s cascade to
  all routes behind it.

CAUSAL CHAIN
  1. Flash sale spike increases checkout demand
  2. Payment provider returns 429 (rate limited)
  3. App retries immediately — fixed interval, no backoff
  4. Worker pool saturates → queue depth hits 216
  5. All routes behind the pool start timing out
  6. 504s cascade to /checkout and /orders/:id

NEXT OPERATOR STEP
  ✓ Disable retries to the payment dependency
  ✓ Add exponential backoff or circuit breaker
  ✓ Shed non-critical checkout work to free workers

AVOID ASSUMING
  ✗ Database is the bottleneck — connections stable, no latency spike
  ✗ Recent deploy caused this — unrelated to concurrency config
  ✗ Scaling the DB will help — confirm bottleneck first
```
<p align="center">
  <img src="assets/frames/frame_0002.png" alt="3am Console — incident diagnosis" width="720"/>
</p>

---

## クイックスタート

```bash
npx 3am-cli init          # OTel でアプリを計装
npx 3am-cli local         # ローカルレシーバを起動 (Docker)
npx 3am-cli local demo    # デモインシデントを注入 → 診断を確認
```

**http://localhost:3333** を開く。Docker と Node.js 20+ が必要です。

<details>
<summary>どのモードを選べばいい？</summary>

| | `automatic` モード | `manual` モード |
|---|---|---|
| **利用ケース** | `ANTHROPIC_API_KEY`（または `OPENAI_API_KEY`）を持っている | Claude Code / Codex / Ollama のサブスクリプションを使っていて API キーはない |
| **診断の実行方法** | レシーバがインシデント発生時にサーバーサイドで LLM を呼び出す | Console で「Run Diagnosis」をクリックし、ブリッジ経由でローカル CLI にルーティング |
| **セットアップ** | `npx 3am-cli init --mode auto --provider anthropic` | `npx 3am-cli init --mode manual --provider claude-code` |
| **ブリッジの要否** | 不要 | 必要 — `npx 3am-cli bridge` を別ターミナルで実行 |

**API キーがある場合 → `auto` モードが本番向けパス:**

```bash
npx 3am-cli init --mode auto --provider anthropic
export ANTHROPIC_API_KEY=sk-ant-...
npx 3am-cli deploy vercel
```

**Claude Code / Codex サブスクリプションを使う場合 → `manual` モード:**

```bash
npx 3am-cli init --mode manual --provider claude-code
npx 3am-cli local              # ターミナル 1
npx 3am-cli bridge             # ターミナル 2
```

> **よくある間違い:** `--mode manual --provider anthropic` は矛盾しています。manual モードはサーバーサイドの API キーがないときのためのものです。`ANTHROPIC_API_KEY` を持っているなら `--mode auto --provider anthropic` を使ってください。

</details>

<details>
<summary>各コマンドの役割</summary>

**`3am init`** はランタイムを検出し、OTel を自動でセットアップします:
- **Node.js / Vercel** — OTel 依存をインストールし、`instrumentation.ts` を作成、OTLP エンドポイントを `.env` に書き込む
- **Cloudflare Workers** — `wrangler.toml` を更新して Workers Observability を有効化

**`3am local demo`** は合成インシデントを注入し、実際の LLM 診断を実行します（約 ¥10/回）。デモデータは `service.name=3am-demo` なので、本番テレメトリと混ざりません。

**診断モード:**
- **automatic** — レシーバがサーバーサイドで診断を実行（API キーが必要）
- **manual** — Claude Code / Codex / Ollama でローカルに診断をルーティング（API キー不要）

**manual モードの注意:**
- manual モードでは `npx 3am-cli bridge` を起動してください。これにより Console の再実行とチャットがローカルプロバイダに到達できます
- 手動診断を直接実行することもできます:

```bash
npx 3am-cli diagnose \
  --incident-id inc_000001 \
  --receiver-url http://localhost:3333 \
  --provider claude-code
```

**リモート manual モード（デプロイ済みレシーバへブリッジ）:**

レシーバが Vercel / Cloudflare にデプロイされているけれど、診断は手元の Claude Code や Codex サブスクリプションで回したい場合は、`--receiver-url` フラグを使います:

```bash
npx 3am-cli bridge --receiver-url https://your-3am-receiver.vercel.app
```

ブリッジは WebSocket 経由でデプロイ済みレシーバに接続し（CF Workers では Durable Objects、Vercel では HTTP upgrade）、診断リクエストをローカルで処理します。認証トークンは `npx 3am-cli deploy` が保存した資格情報から自動検出されます。

**manual モードのワークフロー（ローカル/ホスト済みレシーバ共通）:**
- `npx 3am-cli init --mode manual --provider claude-code|codex|ollama`
- ブリッジを起動: `npx 3am-cli bridge`（リモートレシーバなら `--receiver-url <url>` を付与）
- サーバーサイドのプロバイダ環境変数が manual モードより優先されないようにレシーバを起動する
  ブリッジ側のプロバイダ選択だけを反映したい場合は、レシーバプロセスから `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` を外してください
- ローカルレシーバの場合、`npx 3am-cli local` は自動的に `ALLOW_INSECURE_DEV_MODE=true` を設定します
- 別途 dev レシーバを起動する場合、トークンなしで Console アクセスしたいなら自分で `ALLOW_INSECURE_DEV_MODE=true` を設定してください

**Console の dev プロキシと認証:**
- Console を dev で別起動する場合、Vite プロキシはデフォルトで `http://localhost:3333` のレシーバを想定します
- レシーバが別ポートにある場合のみ `VITE_RECEIVER_BASE_URL` で上書きしてください
- `npx 3am-cli local` は `ALLOW_INSECURE_DEV_MODE=true` を設定するので、Console の API リクエストにトークンは不要です
- `ALLOW_INSECURE_DEV_MODE=true` を設定せずにレシーバを起動した場合、API ルートは `RECEIVER_AUTH_TOKEN` を要求し、Console はワンタイムのセキュアサインインリンクを要求します

</details>

---

## デプロイ

| | コマンド | 得られるもの |
|---|---|---|
| [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/muras3/3am&env=ANTHROPIC_API_KEY&products=%5B%7B%22type%22%3A%22integration%22%2C%22group%22%3A%22postgres%22%7D%5D&project-name=3am) | `npx 3am-cli deploy vercel` | Neon Postgres 自動プロビジョニング、ワンタイムのセキュアサインインリンク |
| **Cloudflare** | `npx 3am-cli deploy cloudflare` | D1 ストレージ、Workers Observability 連携 |

<details>
<summary>Cloudflare デプロイ — 必要な API トークン権限</summary>

https://dash.cloudflare.com/profile/api-tokens で Cloudflare API トークンを作成し、以下の権限**すべて**を付与したうえで、`deploy cloudflare` の前に export してください:

- `Account Settings: Read`
- `Workers Scripts: Edit`
- `D1: Edit`
- `Cloudflare Queues: Edit`
- `Workers Observability: Edit`

```bash
export CLOUDFLARE_API_TOKEN=your-cloudflare-api-token
npx 3am-cli deploy cloudflare --yes
```

> `Workers Observability: Edit` は OTLP destinations API に必須ですが、Cloudflare のプリセット「Edit Workers」テンプレートには含まれていません。カスタムトークンを使ってください。

</details>

デプロイ後、CLI が Console 用の短命ワンタイムサインインリンクを出力します。後からもう一度発行するには `npx 3am-cli auth-link [receiver-url]` を実行してください。

---

## 仕組み

```
あなたのアプリ ──OTel──→ Receiver ──→ LLM ──→ Console
                     spans, logs,    anomaly     root cause,    incident board,
                     metrics         detection   action plan    evidence explorer
```

Receiver は OTLP/HTTP テレメトリを取り込みます。異常がしきい値を超えると、何が壊れているかを構造化したスナップショットである **incident packet** を形成し、LLM に渡します。しきい値の設定もルール記述も不要です。

**LLM プロバイダの自動検出** — 利用可能なものを使います。設定不要です:

| 優先度 | プロバイダ | 検出条件 |
|----------|----------|-----------|
| 1 | Anthropic | `ANTHROPIC_API_KEY` が環境変数にある |
| 2 | Claude Code | `claude` CLI が PATH にある |
| 3 | Codex | `codex` CLI が PATH にある |
| 4 | OpenAI | `OPENAI_API_KEY` が環境変数にある |
| 5 | Ollama | localhost:11434 で稼働中（無料・ローカル） |

---

## さらに詳しく

<details>
<summary><strong>設定</strong> — 保持期間、通知、ログ</summary>

### 保持期間

`RETENTION_HOURS` はテレメトリとクローズ済みインシデントの保持期間を制御します。デフォルト: `48` 時間。

オープン中のインシデントは保持設定にかかわらず削除されません。

### 通知

```bash
npx 3am-cli integrations notifications
```

Slack および/または Discord をデプロイ済みレシーバに接続します。設定後、3am は親インシデント通知を投稿し、診断が完了すると同じ Slack スレッド / Discord スレッドで追記します。

セットアップリファレンス:
- [OSS 通知セットアップ](docs/integrations/notifications-oss-setup.ja.md)

最小の Slack スコープ:
- `chat:write`
- `channels:read`
- プライベートチャンネルを選択可能にする場合は `groups:read`

最小の Discord bot 権限:
- `View Channels`
- `Send Messages`
- `Create Public Threads`
- `Send Messages in Threads`
- `Read Message History`

### ログ

`@opentelemetry/auto-instrumentations-node` を通した構造化ロガー（pino、winston、bunyan）が必要です。`console.log` はキャプチャされません。

</details>

<details>
<summary><strong>セキュリティ</strong></summary>

- デプロイ前に [Anthropic の支出上限](https://console.anthropic.com/settings/billing) を設定してください — 診断はインシデントごとに実行されます
- デプロイ時に短命ワンタイムサインインリンクが表示されます。後からは `npx 3am-cli auth-link` で発行し直せます
- API キーはサーバーサイドのみで、ブラウザには露出しません

</details>

<details>
<summary><strong>なぜ <code>3am init</code> は <code>next build</code> を <code>next build --webpack</code> に変更するの？</strong></summary>

OpenTelemetry の自動計装（`@opentelemetry/auto-instrumentations-node`）は [require-in-the-middle](https://github.com/elastic/require-in-the-middle) を使って Node.js のモジュールを `require()` 時にフックします。これは **バンドル外に残されたモジュール** を Node の実 `require` がランタイムでロードする場合にのみ動作します。Webpack と Next.js の `serverExternalPackages` の組み合わせは、こうしたモジュールを除外するための成熟したサポートを持っています。Turbopack の externalization はこのケースをまだカバーしておらず、Turbopack ビルド下では OTel 計装がテレメトリを出さずに静かに止まります。

そのため `3am init` は `package.json` のビルドスクリプトの `"next build"` を `"next build --webpack"` に書き換え、本番ビルドで Webpack を強制します。dev サーバ（`next dev`）には影響しません。

Turbopack が OTel が必要とする externalization セマンティクスを完全にサポートする（あるいは OTel が require-in-the-middle の Turbopack ネイティブな代替を出す）まで、このワークアラウンドは必要です。それまで `--webpack` を外すと、ビルドは通るように見えてもテレメトリを出さなくなります。

</details>

<details>
<summary><strong>CLI リファレンス</strong></summary>

```bash
npx 3am-cli init                                    # アプリに OTel をセットアップ
npx 3am-cli init --mode auto --provider anthropic   # auto モード (API キー経路)
npx 3am-cli init --mode manual --provider claude-code  # manual モード (サブスクリプション経路)
npx 3am-cli local                                   # ローカルレシーバを起動
npx 3am-cli local demo                              # デモインシデントを実行
npx 3am-cli deploy vercel|cloudflare                # プラットフォームへデプロイ
npx 3am-cli integrations notifications              # Slack/Discord 通知を接続
npx 3am-cli auth-link [receiver-url]                # サインインリンクを再発行
npx 3am-cli diagnose --incident-id inc_000001       # 手動診断
npx 3am-cli bridge                                  # ローカル診断ブリッジを起動 (ローカルレシーバ)
npx 3am-cli bridge --receiver-url <url>             # WebSocket 経由でリモートレシーバにブリッジ
```

`init` フラグ: `--api-key`、`--mode auto|manual`、`--provider anthropic|openai|claude-code|codex|ollama`、`--model`、`--lang en|ja`、`--no-interactive`

`bridge` フラグ: `--port`（デフォルト 4269）、`--receiver-url`（リモート WebSocket 接続先。省略時は資格情報から自動検出）

`deploy` フラグ: `--yes`、`--no-interactive`、`--json`、`--project-name`、`--auth-token`

`integrations notifications` フラグ: `--receiver-url`、`--auth-token`、`--provider slack|discord|both`、`--slack-bot-token`、`--slack-channel-id`、`--discord-bot-token`、`--discord-channel-id`、`--discord-webhook-url`

推奨される OSS オンボーディング:

```bash
# Slack + Discord の bot 資格情報は自身のワークスペース/サーバで事前に作成しておく
npx 3am-cli integrations notifications \
  --provider both \
  --slack-bot-token xoxb-... \
  --slack-channel-id C... \
  --discord-bot-token ... \
  --discord-channel-id ...
```

</details>

<sub><a href="llms-full.txt">AI agents: read llms-full.txt for machine-readable setup instructions</a></sub>

---

## ライセンス

Apache-2.0 — [LICENSE](LICENSE) を参照してください。
